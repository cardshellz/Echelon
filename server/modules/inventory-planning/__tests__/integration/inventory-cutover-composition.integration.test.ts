import type { PoolClient } from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql, cutoverCompositionSeedSql, cutoverCompositionChannelSeedSql, cutoverCompositionObserveOnlySeedSql, installCutoverCompositionMigrations, seedCompositionReviewedDryRun } from "../fixtures/inventory-cutover-composition-database.fixture";
import { PostgresInventoryCutoverReconstructionRepository } from "../../infrastructure/inventory-cutover-reconstruction.repository";
import { captureProposedClaimSupplySnapshotInsideTransaction } from "../../infrastructure/inventory-availability-shadow.repository";
import { planFreshCutoverClaims } from "../../domain/inventory-cutover-reconstruction-planning";
import { installCutoverAdmissionFixturePrerequisites } from "../fixtures/inventory-cutover-admission.fixture";
import { InventoryAvailabilityActivationService } from "../../application/inventory-availability-activation.service";
import { PostgresInventoryAvailabilityActivationRepository } from "../../infrastructure/inventory-availability-activation.repository";
import { PostgresInventoryCutoverCommitRepository } from "../../infrastructure/inventory-cutover-commit.repository";
import { InventoryCutoverCommitService } from "../../application/inventory-cutover-commit.service";
import type { InventoryActivationDryRun, InventoryActivationCommandResult } from "@shared/types/inventory-availability-phase4";
import { acquireInventoryCutoverFenceInsideTransaction } from "../../infrastructure/inventory-cutover-admission-fence.repository";
import { promoteInventoryCutoverDefinitionsInsideTransaction } from "../../infrastructure/inventory-cutover-definitions.repository";
import { buildInventoryCutoverManifest } from "../../domain/inventory-cutover-manifest";
import { selectedSnapshots } from "../../infrastructure/inventory-availability-activation.repository";
import { PostgresInventoryPublicationOutboxRepository } from "../../infrastructure/inventory-publication-outbox.repository";
import { InventoryPublicationOutboxService } from "../../application/inventory-publication-outbox.service";
import { InventoryPublicationTransportRegistry, type AbsoluteInventoryPublicationRequest } from "../../application/inventory-publication-transport";
import { PostgresQuantityPublicationAdmission } from "../../infrastructure/quantity-publication-admission.repository";
import { InventoryCutoverCompletionService } from "../../application/inventory-cutover-completion.service";
import { PostgresInventoryCutoverCompletionRepository } from "../../infrastructure/inventory-cutover-completion.repository";
import { PostgresInventoryAvailabilityClaimRepository } from "../../infrastructure/inventory-availability-claim.repository";
import { PostgresCanonicalClaimInventoryRepository } from "../../../inventory/infrastructure/canonical-claim-inventory.repository";
import { createAuthorityAwareInventoryPublicationService } from "../../infrastructure/inventory-availability-runtime-publication.repository";

// Only the application's process-global connection is disabled. Every owner under
// test receives the uniquely created disposable pool/client; no owner is mocked.
vi.mock("../../../../db", () => ({ pool: {} }));
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = databaseUrl && disposable ? describe : describe.skip;

dbDescribe.sequential("cutover composition with actual snapshot, claim and receipt owners", () => {
  let database: InventoryCutoverTestDatabase;
  const reconstruction = new PostgresInventoryCutoverReconstructionRepository();
  let dryRun: InventoryActivationDryRun;
  let prepared: InventoryActivationCommandResult;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, cutoverCompositionBaseSql);
    await installCutoverCompositionMigrations(database.pool);
    await database.pool.query(cutoverCompositionSeedSql);
    await installCutoverAdmissionFixturePrerequisites(database.pool);
    await database.pool.query(readFileSync(resolve(process.cwd(),"migrations/236_inventory_cutover_admission.sql"),"utf8"));
  }, 30_000);
  afterAll(async () => { await database?.close(); });

  async function readOnly(work: (client: PoolClient) => Promise<void>) {
    const client = await database.pool.connect();
    try { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); await work(client); }
    finally { await client.query("ROLLBACK"); client.release(); }
  }

  it("captures real proposed models, exact physical stock and cumulative fresh demand without writes", async () => readOnly(async (client) => {
    const plan = await reconstruction.preview(client);
    expect(plan.blockers).toEqual([]);
    const snapshot = await captureProposedClaimSupplySnapshotInsideTransaction(client, [101]);
    expect(snapshot.transformationModels).toMatchObject([{ productId: 20, lifecycleSelection: "draft_head" }]);
    expect(snapshot.inventoryPositions).toMatchObject([{ inventoryLevelId: 10, variantQty: "20", reservedQty: "3", pickedQty: "2" }]);
    const fresh = planFreshCutoverClaims(snapshot, plan);
    expect(fresh.freshReservationsByLevel).toEqual([{ inventoryLevelId: 10, reservedQty: "1" }]);
    expect((await client.query("SELECT count(*)::int AS count FROM inventory.availability_claims")).rows[0].count).toBe(0);
    expect((await client.query("SELECT authority FROM inventory.availability_runtime_authority")).rows).toEqual([{ authority: "legacy" }]);
  }));

  it("installs real append-only commit receipt DDL without changing authority", async () => {
    const guards = (await database.pool.query<{ name: string }>(
      `SELECT tgname AS name FROM pg_trigger WHERE tgrelid='inventory.availability_cutover_commits'::regclass AND NOT tgisinternal`,
    )).rows;
    expect(guards.map(row => row.name).sort()).toEqual(["availability_cutover_commits_insert_guard","availability_cutover_commits_update_guard"]);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.availability_cutover_commits")).rows[0].count).toBe(0);
  });

  it("persists reviewed dry-run evidence against the real captured graph", async () => {
    dryRun = await seedCompositionReviewedDryRun(database.pool);
    expect(dryRun).toMatchObject({ state:"ready_for_publication",products:[{ productId:20,status:"ready" }] });
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.availability_activation_product_evidence")).rows[0].count).toBe(1);
  });

  it("prepares through the actual exclusive fence and leaves demand and stock unmodified", async () => {
    const service = new InventoryAvailabilityActivationService(new PostgresInventoryAvailabilityActivationRepository(database.pool),
      { now: () => new Date(dryRun.completedAt) });
    prepared = await service.prepare({ sourceDryRunId:dryRun.activationRunId,expectedDryRunResultHash:dryRun.resultHash,
      idempotencyKey:"composition-prepare",reason:"Prepare reviewed exact demand" },"operator");
    expect(prepared).toMatchObject({ state:"publication_verified",runtimeAuthority:"legacy" });
    expect((await database.pool.query("SELECT reserved_qty,picked_qty FROM inventory.inventory_levels")).rows)
      .toEqual([{ reserved_qty:3,picked_qty:2 }]);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.availability_claims")).rows[0].count).toBe(0);
  });

  it("runs actual full review with proven empty publication drain without changing authority", async () => {
    const service = new InventoryCutoverCommitService(new PostgresInventoryCutoverCommitRepository(database.pool),
      { now: () => new Date(dryRun.completedAt) });
    const review = await service.preview({ activationRunId:prepared.activationRunId },"operator");
    expect(review.blockers).toEqual([]);
    expect((await database.pool.query("SELECT authority FROM inventory.availability_runtime_authority")).rows).toEqual([{ authority:"legacy" }]);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.availability_cutover_commits")).rows[0].count).toBe(0);
  });

  it("adopts exact picked custody through actual admission and active snapshot, then caller rollback restores everything", async () => {
    // Owner-composition rollback proof, not a bypass or a successful final cutover.
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const fence = await acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority:"legacy",expectedConfigurationRunId:prepared.activationRunId });
      const plan = await reconstruction.preview(client);
      const proposed = await captureProposedClaimSupplySnapshotInsideTransaction(client,[101]);
      const fresh = planFreshCutoverClaims(proposed,plan);
      const manifest = buildInventoryCutoverManifest(dryRun,await selectedSnapshots(client,dryRun));
      await promoteInventoryCutoverDefinitionsInsideTransaction(client,manifest,{ actor:"operator",reason:"Owner rollback proof",occurredAt:new Date(dryRun.completedAt) });
      const beforeCosts = (await client.query("SELECT * FROM oms.order_item_costs ORDER BY id")).rows;
      const receipt = await reconstruction.persistReviewed(client,{ expectedEvidenceHash:plan.evidenceHash,activationRunId:prepared.activationRunId,
        runtimeAuthorityRevision:(BigInt(fence.authorityRevision)+BigInt(1)).toString(),actor:"operator",reason:"Owner rollback proof",occurredAt:dryRun.completedAt },fresh.impactHash);
      expect(receipt.claimIds).toHaveLength(1);
      expect((await client.query("SELECT variant_qty,reserved_qty,picked_qty FROM inventory.inventory_levels")).rows)
        .toEqual([{ variant_qty:20,reserved_qty:4,picked_qty:2 }]);
      expect((await client.query("SELECT * FROM oms.order_item_costs ORDER BY id")).rows).toEqual(beforeCosts);
      expect((await client.query("SELECT quantity::text,total_cost_mills::text,order_item_cost_id FROM inventory.availability_claim_pick_movements")).rows)
        .toEqual([{ quantity:"2",total_cost_mills:"18014398509481990",order_item_cost_id:9 }]);
    } finally { await client.query("ROLLBACK"); client.release(); }
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.availability_claims")).rows[0].count).toBe(0);
    expect((await database.pool.query("SELECT reserved_qty FROM inventory.inventory_levels")).rows).toEqual([{ reserved_qty:3 }]);
    expect((await database.pool.query("SELECT lifecycle_status FROM inventory.transformation_model_versions")).rows).toEqual([{ lifecycle_status:"draft" }]);
  });

  it("completes an actual zero-publication cutover without inventing provider evidence", async () => {
    const clock={ now:() => new Date(dryRun.completedAt) };
    const service=new InventoryCutoverCommitService(new PostgresInventoryCutoverCommitRepository(database.pool),clock);
    const review=await service.preview({ activationRunId:prepared.activationRunId },"operator");
    expect(review.blockers).toEqual([]);
    const committed=await service.commit({ activationRunId:prepared.activationRunId,expectedAuthorityRevision:review.authorityRevision,
      expectedReviewHash:review.reviewHash,idempotencyKey:"composition-zero-commit",reason:"Reviewed zero external targets" },"operator");
    expect(committed.fullPublicationRows).toBe(0);
    const completion=new InventoryCutoverCompletionService(new PostgresInventoryCutoverCompletionRepository(database.pool),clock);
    const verification=await completion.verify({ activationRunId:prepared.activationRunId },"operator");
    expect(verification).toMatchObject({ ready:true,expectedPublicationRows:0,verifiedPublicationRows:0,blockers:[] });
    const request={ activationRunId:prepared.activationRunId,expectedVerificationHash:verification.verificationHash,
      idempotencyKey:"composition-zero-finish",reason:"Finish zero publication manifest" };
    expect(await completion.finish(request,"operator")).toMatchObject({ configurationFreezeReleased:true,verifiedPublicationRows:0 });
    expect(await completion.finish(request,"operator")).toMatchObject({ alreadyApplied:true });
    expect((await database.pool.query("SELECT activation_run_id FROM inventory.quantity_publication_gate")).rows).toEqual([{ activation_run_id:null }]);
  });
});

dbDescribe.sequential("empty-bin promise handoff through complete cutover composition", () => {
  let database: InventoryCutoverTestDatabase;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, cutoverCompositionBaseSql);
    await installCutoverCompositionMigrations(database.pool);
    await database.pool.query(cutoverCompositionSeedSql);
    await database.pool.query(cutoverCompositionChannelSeedSql);
    await database.pool.query(`DELETE FROM oms.order_item_costs; DELETE FROM inventory.inventory_transactions;
      UPDATE wms.order_items SET picked_quantity=0;
      UPDATE inventory.inventory_levels SET variant_qty=0,reserved_qty=6,picked_qty=0;
      UPDATE inventory.inventory_lots SET qty_on_hand=0,qty_reserved=0,qty_picked=0;
      INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code) VALUES(200,1,'OTHER-PICK');
      INSERT INTO inventory.inventory_levels(id,warehouse_location_id,product_variant_id,variant_qty,reserved_qty,picked_qty,packed_qty)
        VALUES(20,200,101,20,0,0,0);
      INSERT INTO inventory.inventory_lots(id,warehouse_location_id,product_variant_id,qty_on_hand,qty_reserved,qty_picked,status,received_at,
        unit_cost_mills,po_unit_cost_mills,packaging_cost_mills,landed_cost_mills,total_unit_cost_mills)
        VALUES(5,200,101,20,0,0,'active','2026-09-01T00:00:00Z',1000,1000,0,0,1000);
      INSERT INTO inventory.inventory_transactions(order_id,order_item_id,product_variant_id,to_location_id,transaction_type,
        variant_qty_delta,variant_qty_before,variant_qty_after,reserved_qty_delta,source_state,target_state)
        VALUES(1,11,101,100,'reserve',0,0,0,6,'on_hand','committed')`);
    await installCutoverAdmissionFixturePrerequisites(database.pool);
    await database.pool.query(readFileSync(resolve(process.cwd(), "migrations/236_inventory_cutover_admission.sql"), "utf8"));
  }, 30_000);
  afterAll(async () => { await database?.close(); });

  it("agrees on conservative/full publication, rolls back later failures, and serializes concurrent retries", async () => {
    const dryRun = await seedCompositionReviewedDryRun(database.pool);
    const now = new Date(Date.parse(dryRun.completedAt) + 10);
    const clock = { now: () => now };
    const activation = new InventoryAvailabilityActivationService(new PostgresInventoryAvailabilityActivationRepository(database.pool), clock);
    const prepared = await activation.prepare({ sourceDryRunId: dryRun.activationRunId, expectedDryRunResultHash: dryRun.resultHash,
      idempotencyKey: "promise-composition-prepare", reason: "Preserve reviewed empty-bin customer demand" }, "operator");
    expect(prepared).toMatchObject({ state: "publishing", runtimeAuthority: "legacy" });
    expect((await database.pool.query("SELECT desired_quantity::text,publication_phase FROM inventory.inventory_publication_outbox")).rows)
      .toEqual([{ desired_quantity: "14", publication_phase: "conservative" }]);
    expect((await database.pool.query("SELECT id,reserved_qty FROM inventory.inventory_levels ORDER BY id")).rows)
      .toEqual([{ id: 10, reserved_qty: 6 }, { id: 20, reserved_qty: 0 }]);

    let observed = 20;
    const transports = new InventoryPublicationTransportRegistry();
    const publishAbsolute = vi.fn(async (request: AbsoluteInventoryPublicationRequest) => {
      observed = request.desiredQuantity; return { publishedQuantity: observed, providerResponse: { testOnly: true } };
    });
    transports.register({ destinationKind: "channel_connection", providerKey: "shopify", supportedScopeTypes: ["location"], publishAbsolute,
      readAbsolute: async () => ({ observedQuantity: observed, providerResponse: { testOnly: true } }) });
    const publisher = new InventoryPublicationOutboxService(new PostgresInventoryPublicationOutboxRepository(database.pool), transports,
      clock, () => "promise-composition-lease", new PostgresQuantityPublicationAdmission(database.pool, () => now,
        () => "00000000-0000-4000-8000-000000000040"));
    expect(await publisher.processDue({ batchSize: 1, leaseSeconds: 60 })).toEqual({ claimed: 1, verified: 1, failed: 0, superseded: 0 });
    expect(publishAbsolute).toHaveBeenCalledOnce();
    const cutover = new InventoryCutoverCommitService(new PostgresInventoryCutoverCommitRepository(database.pool), clock);
    const review = await cutover.preview({ activationRunId: prepared.activationRunId }, "operator");
    expect(review.blockers).toEqual([]);
    expect(review.publicationRows).toEqual([{ publicationTargetId: 1, productVariantId: 101, desiredQuantity: "14" }]);
    const command = { activationRunId: prepared.activationRunId, expectedAuthorityRevision: review.authorityRevision,
      expectedReviewHash: review.reviewHash, idempotencyKey: "promise-composition-commit", reason: "Preserve exact demand with new physical allocation" };
    await database.pool.query(`CREATE FUNCTION public.fail_promise_cutover_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test promise final receipt failure'; END $$;
      CREATE TRIGGER zz_promise_receipt_failure BEFORE INSERT ON inventory.availability_cutover_commits
        FOR EACH ROW EXECUTE FUNCTION public.fail_promise_cutover_receipt()`);
    try { await expect(cutover.commit(command, "operator")).rejects.toThrow("test promise final receipt failure"); }
    finally { await database.pool.query("DROP TRIGGER zz_promise_receipt_failure ON inventory.availability_cutover_commits; DROP FUNCTION public.fail_promise_cutover_receipt()"); }
    expect((await database.pool.query("SELECT authority FROM inventory.availability_runtime_authority")).rows).toEqual([{ authority: "legacy" }]);
    expect((await database.pool.query("SELECT id,reserved_qty FROM inventory.inventory_levels ORDER BY id")).rows)
      .toEqual([{ id: 10, reserved_qty: 6 }, { id: 20, reserved_qty: 0 }]);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.inventory_transactions WHERE reference_type='inventory_cutover_promise'")).rows[0].count).toBe(0);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.availability_claims")).rows[0].count).toBe(0);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.availability_cutover_reconstruction_receipts")).rows[0].count).toBe(0);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.availability_cutover_commits")).rows[0].count).toBe(0);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.inventory_publication_outbox WHERE publication_phase='full'")).rows[0].count).toBe(0);
    const outcomes = await Promise.all([cutover.commit(command, "operator"), cutover.commit(command, "operator")]);
    expect(outcomes.map((outcome) => outcome.alreadyApplied).sort()).toEqual([false, true]);
    expect((await database.pool.query("SELECT id,variant_qty,reserved_qty,picked_qty FROM inventory.inventory_levels ORDER BY id")).rows)
      .toEqual([{ id: 10, variant_qty: 0, reserved_qty: 0, picked_qty: 0 }, { id: 20, variant_qty: 20, reserved_qty: 6, picked_qty: 0 }]);
    expect((await database.pool.query("SELECT id,qty_on_hand,qty_reserved,qty_picked,total_unit_cost_mills::text FROM inventory.inventory_lots ORDER BY id")).rows)
      .toEqual([{ id: 4, qty_on_hand: 0, qty_reserved: 0, qty_picked: 0, total_unit_cost_mills: "9007199254740995" },
        { id: 5, qty_on_hand: 20, qty_reserved: 6, qty_picked: 0, total_unit_cost_mills: "1000" }]);
    expect((await database.pool.query("SELECT requested_qty::text,planned_qty::text,shortfall_qty::text FROM inventory.availability_claim_lines")).rows)
      .toEqual([{ requested_qty: "6", planned_qty: "6", shortfall_qty: "0" }]);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.inventory_transactions WHERE reference_type='inventory_cutover_promise'")).rows[0].count).toBe(1);
    expect((await database.pool.query("SELECT desired_quantity::text FROM inventory.inventory_publication_outbox WHERE publication_phase='full'")).rows)
      .toEqual([{ desired_quantity: "14" }]);
    expect((await database.pool.query("SELECT * FROM oms.order_item_costs")).rows).toEqual([]);
  }, 20_000);
});

dbDescribe.sequential("cutover abort, concurrent provider and external-owned destination composition", () => {
  let database:InventoryCutoverTestDatabase;
  let dryRun:InventoryActivationDryRun;
  let prepared:InventoryActivationCommandResult;
  let now:Date;
  const scope={ destinationKind:"channel_connection" as const,connectionId:7,providerKey:"shopify" as const,
    providerScopeType:"location" as const,externalScopeId:"test-location",externalInventoryItemId:"test-item",productId:20,productVariantId:101 };
  function activation() { return new InventoryAvailabilityActivationService(new PostgresInventoryAvailabilityActivationRepository(database.pool),{ now:() => now }); }
  function prepareRequest(key:string) { return { sourceDryRunId:dryRun.activationRunId,expectedDryRunResultHash:dryRun.resultHash,idempotencyKey:key,reason:"Review external destination ownership" }; }
  beforeAll(async () => {
    database=await createInventoryCutoverTestDatabase(databaseUrl,disposable,cutoverCompositionBaseSql);
    await installCutoverCompositionMigrations(database.pool);
    await database.pool.query(cutoverCompositionSeedSql);
    await database.pool.query(cutoverCompositionChannelSeedSql);
    await database.pool.query(cutoverCompositionObserveOnlySeedSql);
    await installCutoverAdmissionFixturePrerequisites(database.pool);
    await database.pool.query(readFileSync(resolve(process.cwd(),"migrations/236_inventory_cutover_admission.sql"),"utf8"));
    dryRun=await seedCompositionReviewedDryRun(database.pool); now=new Date(Date.parse(dryRun.completedAt)+10);
  },30_000);
  afterAll(async () => { await database?.close(); });

  it("rolls back preparation while an actual admitted provider owner is still in flight", async () => {
    let signalStarted!:() => void; let releaseProvider!:() => void;
    const started=new Promise<void>(resolve => { signalStarted=resolve; });
    const complete=new Promise<void>(resolve => { releaseProvider=resolve; });
    const admission=new PostgresQuantityPublicationAdmission(database.pool,() => now,() => "00000000-0000-4000-8000-000000000003");
    const owner=admission.run(scope,async () => { signalStarted(); await complete; return { acknowledged:true }; });
    try {
      await started;
      await expect(activation().prepare(prepareRequest("composition-busy-prepare"),"operator")).rejects.toMatchObject({ code:"QUANTITY_PUBLICATION_DRAIN_BUSY" });
    } finally { releaseProvider(); await owner; }
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.availability_activation_freezes WHERE released_at IS NULL")).rows[0].count).toBe(0);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.inventory_publication_outbox")).rows[0].count).toBe(0);
  });

  it("prepares only the controlled target and leaves a reviewed live external provider untouched", async () => {
    expect(dryRun.products[0].proposedPublications).toHaveLength(2);
    prepared=await activation().prepare(prepareRequest("composition-observe-prepare"),"operator");
    expect(prepared).toMatchObject({ conservativePublicationRows:1,runtimeAuthority:"legacy" });
    expect((await database.pool.query("SELECT id,state,revision::text,publication_authority FROM inventory.inventory_publication_targets ORDER BY id")).rows)
      .toEqual([{ id:1,state:"preview",revision:"2",publication_authority:"echelon" },{ id:2,state:"live",revision:"3",publication_authority:"external_provider" }]);
    expect((await database.pool.query("SELECT publication_target_id FROM inventory.inventory_publication_outbox")).rows).toEqual([{ publication_target_id:1 }]);
  });

  it("retains a suppressed quantity refresh, aborts atomically and makes current-state catch-up eligible", async () => {
    const admission=new PostgresQuantityPublicationAdmission(database.pool,() => now,() => "00000000-0000-4000-8000-000000000004");
    const provider=vi.fn(async () => ({ acknowledged:true }));
    await expect(admission.run(scope,provider)).rejects.toMatchObject({ code:"QUANTITY_PUBLICATION_SUPPRESSED" });
    expect(provider).not.toHaveBeenCalled();
    expect(await admission.listDue(10)).toEqual([]);
    const request={ activationRunId:prepared.activationRunId,idempotencyKey:"composition-abort",reason:"Abort reviewed local test safely" };
    const aborted=await activation().abort(request,"operator");
    expect(aborted).toMatchObject({ state:"failed",runtimeAuthority:"legacy",publicationCatchupPending:true });
    expect(await activation().abort(request,"operator")).toEqual({ ...aborted,alreadyApplied:true });
    expect((await database.pool.query("SELECT activation_run_id FROM inventory.quantity_publication_gate")).rows).toEqual([{ activation_run_id:null }]);
    expect((await database.pool.query("SELECT state FROM inventory.inventory_publication_outbox")).rows).toEqual([{ state:"cancelled" }]);
    expect((await admission.listDue(10))).toMatchObject([{ scope:{ connectionId:7,externalInventoryItemId:"test-item" } }]);
    expect((await database.pool.query("SELECT reserved_qty,picked_qty FROM inventory.inventory_levels")).rows).toEqual([{ reserved_qty:3,picked_qty:2 }]);
  });

  it("keeps an uncertain legacy outcome as a real readiness blocker after preparation", async () => {
    const admission=new PostgresQuantityPublicationAdmission(database.pool,() => now,() => "00000000-0000-4000-8000-000000000005");
    await expect(admission.run(scope,async () => { throw new Error("simulated response lost after send"); })).rejects.toThrow("simulated response lost");
    const next=await activation().prepare(prepareRequest("composition-uncertain-prepare"),"operator");
    const service=new InventoryCutoverCommitService(new PostgresInventoryCutoverCommitRepository(database.pool),{ now:() => now });
    const review=await service.preview({ activationRunId:next.activationRunId },"operator");
    expect(review.ready).toBe(false);
    expect(review.blockers.map(row => row.code)).toContain("CUTOVER_PUBLICATION_OUTCOME_UNRESOLVED");
    await expect(service.commit({ activationRunId:next.activationRunId,expectedAuthorityRevision:review.authorityRevision,
      expectedReviewHash:review.reviewHash,idempotencyKey:"composition-uncertain-commit",reason:"Unresolved requests cannot cut over" },"operator"))
      .rejects.toMatchObject({ code:"CUTOVER_REVIEW_BLOCKED" });
    expect((await database.pool.query("SELECT state FROM inventory.quantity_publication_attempts WHERE state='uncertain'")).rows).toEqual([{ state:"uncertain" }]);
  });
});

dbDescribe.sequential("cutover composition with one actual publication target", () => {
  let database: InventoryCutoverTestDatabase;
  let dryRun: InventoryActivationDryRun;
  let prepared: InventoryActivationCommandResult;
  let now: Date;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl,disposable,cutoverCompositionBaseSql);
    await installCutoverCompositionMigrations(database.pool);
    await database.pool.query(cutoverCompositionSeedSql);
    await database.pool.query(cutoverCompositionChannelSeedSql);
    await database.pool.query(cutoverCompositionObserveOnlySeedSql);
    await database.pool.query(`INSERT INTO inventory.promise_safety_policy_versions(scope_key,scope_type,product_variant_id,warehouse_id,version,policy_mode,definition_hash,change_reason,idempotency_key,request_hash,created_by)
      VALUES('network:variant:101','network_variant',101,NULL,1,'off',repeat('e',64),'Test network SKU policy','composition-network-safety',repeat('e',64),'operator'),
        ('warehouse:1:variant:101','warehouse_variant',101,1,1,'off',repeat('f',64),'Test warehouse SKU policy','composition-warehouse-safety',repeat('f',64),'operator');
      INSERT INTO inventory.promise_safety_policy_heads(scope_key,draft_policy_id,revision,updated_by,update_reason)
        SELECT scope_key,id,0,'operator','Test complete safety scope locking' FROM inventory.promise_safety_policy_versions WHERE scope_key<>'business'`);
    await installCutoverAdmissionFixturePrerequisites(database.pool);
    await database.pool.query(readFileSync(resolve(process.cwd(),"migrations/236_inventory_cutover_admission.sql"),"utf8"));
    dryRun = await seedCompositionReviewedDryRun(database.pool);
    now = new Date(Date.parse(dryRun.completedAt)+10);
  },30_000);
  afterAll(async () => { await database?.close(); });

  it("prepares conservative quantity using actual post-reconstruction ATP instead of pre-demand stock", async () => {
    // Accepted physical demand arrives after the historical dry-run. Preparation
    // must allocate it along with existing custody, not publish the old17 units.
    await database.pool.query(`INSERT INTO oms.oms_orders(id,status) VALUES(2,'pending');
      INSERT INTO oms.oms_order_lines(id,order_id,product_variant_id,sku,requires_shipping,quantity,authority_fulfillable_quantity,wms_materialized_quantity,authorization_status)
        VALUES(12,2,101,'P5',true,2,2,2,'authorized');
      INSERT INTO wms.orders(id,warehouse_id,warehouse_status,on_hold,channel_id,source,external_order_id,oms_fulfillment_order_id,fulfillment_partition_key)
        VALUES(2,1,'ready',0,36,'shopify','example-2','fo-2','default');
      INSERT INTO wms.order_items(id,order_id,oms_order_line_id,source_item_id,sku,product_id,quantity,picked_quantity,fulfilled_quantity,status,on_hold,requires_shipping)
        VALUES(12,2,12,'source-12','P5',101,2,0,0,'pending',false,1)`);
    const service = new InventoryAvailabilityActivationService(new PostgresInventoryAvailabilityActivationRepository(database.pool),{ now:() => now });
    prepared = await service.prepare({ sourceDryRunId:dryRun.activationRunId,expectedDryRunResultHash:dryRun.resultHash,
      idempotencyKey:"composition-channel-prepare",reason:"Prepare one exact channel" },"operator");
    expect(prepared).toMatchObject({ state:"publishing",conservativePublicationRows:1,runtimeAuthority:"legacy" });
    expect((await database.pool.query("SELECT desired_quantity::text,publication_phase,state FROM inventory.inventory_publication_outbox")).rows)
      .toEqual([{ desired_quantity:"14",publication_phase:"conservative",state:"queued" }]);
    expect((await database.pool.query("SELECT reserved_qty FROM inventory.inventory_levels")).rows).toEqual([{ reserved_qty:3 }]);
  });

  it("uses actual outbox lease and verification owners for conservative provider evidence", async () => {
    const outbox = new PostgresInventoryPublicationOutboxRepository(database.pool);
    const adapters = new InventoryPublicationTransportRegistry();
    let observed=20;
    const publishAbsolute = vi.fn(async (request:AbsoluteInventoryPublicationRequest) => {
      observed=request.desiredQuantity; return { publishedQuantity:observed,providerResponse:{ testOnly:true } };
    });
    adapters.register({ destinationKind:"channel_connection",providerKey:"shopify",supportedScopeTypes:["location"],publishAbsolute,
      readAbsolute:async () => ({ observedQuantity:observed,providerResponse:{ testOnly:true } }) });
    const service = new InventoryPublicationOutboxService(outbox,adapters,{ now:() => now },() => "composition-lease",
      new PostgresQuantityPublicationAdmission(database.pool,() => now,() => "00000000-0000-4000-8000-000000000001"));
    expect(await service.processDue({ batchSize:1,leaseSeconds:60 })).toEqual({ claimed:1,verified:1,failed:0,superseded:0 });
    expect(publishAbsolute).toHaveBeenCalledOnce();
    expect((await database.pool.query("SELECT state FROM inventory.inventory_publication_outbox")).rows).toEqual([{ state:"verified" }]);
    expect((await database.pool.query("SELECT state FROM inventory.availability_activation_runs WHERE id=$1",[prepared.activationRunId])).rows)
      .toEqual([{ state:"publication_verified" }]);
    expect((await database.pool.query("SELECT owner_kind,state,resolution_basis FROM inventory.quantity_publication_attempts")).rows)
      .toEqual([{ owner_kind:"outbox",state:"succeeded",resolution_basis:"owner_completion" }]);
  });

  it("compares the exact conservative readback with real cumulative-demand projection", async () => {
    const service = new InventoryCutoverCommitService(new PostgresInventoryCutoverCommitRepository(database.pool),{ now:() => now });
    const review = await service.preview({ activationRunId:prepared.activationRunId },"operator");
    expect(review.publicationRows).toEqual([{ publicationTargetId:1,productVariantId:101,desiredQuantity:"14" }]);
    expect(review.blockers).toEqual([]);
  });

  it("commits, publishes, verifies, finishes and replays with actual owners and immutable receipts", async () => {
    const clock={ now:() => now };
    const service=new InventoryCutoverCommitService(new PostgresInventoryCutoverCommitRepository(database.pool),clock);
    const review=await service.preview({ activationRunId:prepared.activationRunId },"operator");
    expect(review.blockers).toEqual([]);
    const request={ activationRunId:prepared.activationRunId,expectedAuthorityRevision:review.authorityRevision,
      expectedReviewHash:review.reviewHash,idempotencyKey:"composition-channel-commit",reason:"Commit reviewed complete demand" };
    await expect(service.commit({ ...request,expectedReviewHash:"0".repeat(64) },"operator")).rejects.toMatchObject({ code:"CUTOVER_REVIEW_CHANGED" });
    // A real operational change after review invalidates the hash even when
    // the observed conservative quantity remains below the new safe quantity.
    await database.pool.query("UPDATE inventory.inventory_levels SET variant_qty=21 WHERE id=10; UPDATE inventory.inventory_lots SET qty_on_hand=21 WHERE id=4");
    try { await expect(service.commit(request,"operator")).rejects.toMatchObject({ code:"CUTOVER_REVIEW_CHANGED" }); }
    finally { await database.pool.query("UPDATE inventory.inventory_levels SET variant_qty=20 WHERE id=10; UPDATE inventory.inventory_lots SET qty_on_hand=20 WHERE id=4"); }
    // A real DB failure after all claim/authority/outbox changes must undo the
    // complete transaction. The existing production guards remain installed.
    await database.pool.query(`CREATE FUNCTION public.fail_composition_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test receipt failure'; END $$;
      CREATE TRIGGER zz_composition_receipt_failure BEFORE INSERT ON inventory.availability_cutover_commits FOR EACH ROW EXECUTE FUNCTION public.fail_composition_receipt()`);
    try { await expect(service.commit(request,"operator")).rejects.toThrow("test receipt failure"); }
    finally { await database.pool.query("DROP TRIGGER zz_composition_receipt_failure ON inventory.availability_cutover_commits; DROP FUNCTION public.fail_composition_receipt()"); }
    expect((await database.pool.query("SELECT authority FROM inventory.availability_runtime_authority")).rows).toEqual([{ authority:"legacy" }]);
    expect((await database.pool.query("SELECT reserved_qty FROM inventory.inventory_levels")).rows).toEqual([{ reserved_qty:3 }]);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.availability_claims")).rows[0].count).toBe(0);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.inventory_publication_outbox WHERE publication_phase='full'")).rows[0].count).toBe(0);
    const originalCosts=(await database.pool.query("SELECT * FROM oms.order_item_costs")).rows;
    const commits=await Promise.allSettled([service.commit(request,"operator"),service.commit(request,"operator")]);
    expect(commits.map(result => result.status)).toEqual(["fulfilled","fulfilled"]);
    expect(commits.flatMap(result => result.status==="fulfilled" ? [result.value.alreadyApplied] : []).sort()).toEqual([false,true]);
    const committed=commits.flatMap(result => result.status==="fulfilled" && !result.value.alreadyApplied ? [result.value] : [])[0];
    expect(committed).toMatchObject({ runtimeAuthority:"canonical",authorityRevision:"2",fullPublicationRows:1,publicationVerification:"pending" });
    expect((await database.pool.query("SELECT state,revision::text FROM inventory.inventory_publication_targets WHERE id=2")).rows)
      .toEqual([{ state:"live",revision:"3" }]);
    expect((await database.pool.query("SELECT reserved_qty,picked_qty,variant_qty FROM inventory.inventory_levels")).rows)
      .toEqual([{ reserved_qty:6,picked_qty:2,variant_qty:20 }]);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.availability_claims")).rows[0].count).toBe(2);
    expect((await database.pool.query("SELECT * FROM oms.order_item_costs")).rows).toEqual(originalCosts);
    expect(await service.commit(request,"operator")).toEqual({ ...committed,alreadyApplied:true });
    const completion=new InventoryCutoverCompletionService(new PostgresInventoryCutoverCompletionRepository(database.pool),clock);
    const pending=await completion.verify({ activationRunId:prepared.activationRunId },"operator");
    expect(pending.ready).toBe(false);
    await expect(completion.finish({ activationRunId:prepared.activationRunId,expectedVerificationHash:pending.verificationHash,
      idempotencyKey:"composition-premature-finish",reason:"Must not unlock before verification" },"operator"))
      .rejects.toMatchObject({ code:"CUTOVER_FULL_PUBLICATION_NOT_VERIFIED" });
    const transport=new InventoryPublicationTransportRegistry();
    // The runtime publisher stamps its actual enqueue time. Advance the injected
    // worker clock to the persisted schedule rather than pretending it is due.
    now = new Date((await database.pool.query<{ due: Date }>("SELECT MAX(available_at) AS due FROM inventory.inventory_publication_outbox WHERE publication_phase='full'")).rows[0].due.getTime()+10);
    const publish=vi.fn(async (input:AbsoluteInventoryPublicationRequest) => ({ publishedQuantity:input.desiredQuantity,providerResponse:{ testOnly:true } }));
    let observedQuantity=14;
    let attemptToken=2;
    transport.register({ destinationKind:"channel_connection",providerKey:"shopify",supportedScopeTypes:["location"],publishAbsolute:publish,
      readAbsolute:async () => ({ observedQuantity,providerResponse:{ testOnly:true } }) });
    const publisher=new InventoryPublicationOutboxService(new PostgresInventoryPublicationOutboxRepository(database.pool),transport,clock,() => "composition-full-lease",
      new PostgresQuantityPublicationAdmission(database.pool,() => now,() => `00000000-0000-4000-8000-${String(attemptToken++).padStart(12,"0")}`));
    expect(await publisher.processDue({ batchSize:1 })).toEqual({ claimed:1,verified:1,failed:0,superseded:0 });
    expect(publish).toHaveBeenCalledOnce();
    let verification=await completion.verify({ activationRunId:prepared.activationRunId },"operator");
    expect(verification).toMatchObject({ ready:true,verifiedPublicationRows:1,blockers:[] });
    const initialVerification=verification;
    const immutableCommit=(await database.pool.query("SELECT publication_manifest,publication_manifest_hash FROM inventory.availability_cutover_commits")).rows;
    // Accepted demand continues while configuration stays frozen. Claim and
    // publish through real canonical owners: the initial14 proof cannot approve
    // a successor13 promise until that new exact revision is observed.
    await database.pool.query(`INSERT INTO oms.oms_orders(id,status) VALUES(3,'pending');
      INSERT INTO oms.oms_order_lines(id,order_id,product_variant_id,sku,requires_shipping,quantity,authority_fulfillable_quantity,wms_materialized_quantity,authorization_status)
        VALUES(13,3,101,'P5',true,1,1,1,'authorized');
      INSERT INTO wms.orders(id,warehouse_id,warehouse_status,on_hold,channel_id,source,external_order_id,oms_fulfillment_order_id,fulfillment_partition_key)
        VALUES(3,1,'ready',0,36,'shopify','example-3','fo-3','default');
      INSERT INTO wms.order_items(id,order_id,oms_order_line_id,source_item_id,sku,product_id,quantity,picked_quantity,fulfilled_quantity,status,on_hold,requires_shipping)
        VALUES(13,3,13,'source-13','P5',101,1,0,0,'pending',false,1)`);
    await new PostgresInventoryAvailabilityClaimRepository(new PostgresCanonicalClaimInventoryRepository(),database.pool,() => now)
      .claimOrder({ orderId:3,idempotencyKey:"composition-post-cutover-demand",actor:"operator",reason:"New demand during full publication verification" });
    expect((await database.pool.query("SELECT scope_key FROM inventory.promise_safety_policy_heads WHERE active_policy_id IS NOT NULL ORDER BY scope_key")).rows)
      .toEqual([{ scope_key:"business" },{ scope_key:"network:variant:101" },{ scope_key:"warehouse:1:variant:101" }]);
    const current=await createAuthorityAwareInventoryPublicationService(database.pool).publishProduct({ productId:20,dryRun:false,
      triggeredBy:"composition_new_order" },async () => { throw new Error("Canonical publication must not call legacy."); });
    expect(current.authority).toBe("canonical");
    const successorPending=await completion.verify({ activationRunId:prepared.activationRunId },"operator");
    expect(successorPending.ready).toBe(false);
    expect(successorPending.publicationRows).toMatchObject([{ desiredQuantity:"13",observedQuantity:"14",state:"queued" }]);
    await expect(completion.finish({ activationRunId:prepared.activationRunId,expectedVerificationHash:initialVerification.verificationHash,
      idempotencyKey:"composition-stale-initial-finish",reason:"Old initial publication cannot finish a newer pending quantity" },"operator"))
      .rejects.toMatchObject({ code:"CUTOVER_FULL_PUBLICATION_NOT_VERIFIED" });
    observedQuantity=13;
    now=new Date((await database.pool.query<{ due:Date }>("SELECT MAX(available_at) AS due FROM inventory.inventory_publication_outbox WHERE publication_phase='full'")).rows[0].due.getTime()+10);
    expect(await publisher.processDue({ batchSize:1 })).toEqual({ claimed:1,verified:1,failed:0,superseded:0 });
    verification=await completion.verify({ activationRunId:prepared.activationRunId },"operator");
    expect(verification).toMatchObject({ ready:true,verifiedPublicationRows:1,blockers:[],publicationRows:[{ desiredQuantity:"13",observedQuantity:"13",state:"verified" }] });
    expect((await database.pool.query("SELECT publication_manifest,publication_manifest_hash FROM inventory.availability_cutover_commits")).rows).toEqual(immutableCommit);
    expect((await database.pool.query("SELECT desired_quantity::text,publication_target_revision_snapshot::text FROM inventory.inventory_publication_outbox WHERE publication_phase='full' ORDER BY desired_revision")).rows)
      .toEqual([{ desired_quantity:"14",publication_target_revision_snapshot:"3" },{ desired_quantity:"13",publication_target_revision_snapshot:"3" }]);
    expect(publish).toHaveBeenCalledTimes(2);
    const finish={ activationRunId:prepared.activationRunId,expectedVerificationHash:verification.verificationHash,
      idempotencyKey:"composition-channel-finish",reason:"Finish verified exact channel" };
    await expect(completion.finish({ ...finish,expectedVerificationHash:"0".repeat(64) },"operator")).rejects.toMatchObject({ code:"CUTOVER_VERIFICATION_CHANGED" });
    const finishes=await Promise.allSettled([completion.finish(finish,"operator"),completion.finish(finish,"operator")]);
    expect(finishes.map(result => result.status)).toEqual(["fulfilled","fulfilled"]);
    const finished=finishes.flatMap(result => result.status==="fulfilled" && !result.value.alreadyApplied ? [result.value] : [])[0];
    expect(finishes.flatMap(result => result.status==="fulfilled" ? [result.value.alreadyApplied] : []).sort()).toEqual([false,true]);
    expect(finished).toMatchObject({ configurationFreezeReleased:true,verifiedPublicationRows:1 });
    expect(await completion.finish(finish,"operator")).toEqual({ ...finished,alreadyApplied:true });
    expect((await database.pool.query("SELECT activation_run_id FROM inventory.quantity_publication_gate")).rows).toEqual([{ activation_run_id:null }]);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.availability_activation_freezes WHERE released_at IS NULL")).rows[0].count).toBe(0);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.quantity_publication_catchup WHERE completed_revision<revision")).rows[0].count).toBe(1);
    await expect(database.pool.query("UPDATE inventory.availability_cutover_commits SET reason='rewrite'")).rejects.toThrow("append-only");
    const claimId=(await database.pool.query<{ id:string }>("SELECT id::text FROM inventory.availability_claims WHERE order_id=1")).rows[0].id;
    const picker=new PostgresInventoryAvailabilityClaimRepository(new PostgresCanonicalClaimInventoryRepository(),database.pool,() => now);
    const pick={ claimId,orderItemId:11,warehouseLocationId:100,quantity:"4",locationStrategy:"strict" as const,
      idempotencyKey:"composition-pick-after-finish",actor:"picker",reason:"Complete imported partial custody",
      wmsProgress:{ expectedStatus:"pending" as const,expectedPickedQuantity:2,targetStatus:"completed" as const,targetPickedQuantity:6 } };
    await picker.pickClaimLine(pick);
    expect((await database.pool.query("SELECT variant_qty,reserved_qty,picked_qty FROM inventory.inventory_levels")).rows)
      .toEqual([{ variant_qty:16,reserved_qty:3,picked_qty:6 }]);
    expect((await database.pool.query("SELECT id,qty,total_cost_mills::text FROM oms.order_item_costs ORDER BY id")).rows)
      .toEqual([{ id:9,qty:2,total_cost_mills:"18014398509481990" },{ id:100,qty:4,total_cost_mills:"36028797018963980" }]);
    await expect(picker.pickClaimLine(pick)).resolves.toMatchObject({ idempotentReplay:true });
    expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.order_item_costs")).rows[0].count).toBe(2);
  },20_000);

  it("plans current canonical listing quantity and rejects forged, expired and superseded outbox leases before HTTP", async () => {
    let token=10;
    const admission=new PostgresQuantityPublicationAdmission(database.pool,() => now,
      () => `00000000-0000-4000-8000-${String(token++).padStart(12,"0")}`);
    const scope={ destinationKind:"channel_connection" as const,connectionId:7,providerKey:"shopify" as const,
      providerScopeType:"location" as const,externalScopeId:"test-location",externalInventoryItemId:"test-item",productId:20,productVariantId:101 };
    const publication=createAuthorityAwareInventoryPublicationService(database.pool);
    async function currentPlan() {
      await publication.publishProduct({ productId:20,dryRun:false,triggeredBy:"composition_listing_current" },
        async () => { throw new Error("Canonical listing cannot call legacy."); });
      const latest=(await database.pool.query<{ id:string;quantity:string;available_at:Date }>(
        "SELECT id::text,desired_quantity::text AS quantity,available_at FROM inventory.inventory_publication_outbox WHERE publication_target_id=1 ORDER BY desired_revision DESC LIMIT 1")).rows[0];
      return { outboxId:latest.id,quantity:Number(latest.quantity),availableAt:latest.available_at };
    }
    const listingHttp=vi.fn(async (quantity:number|null) => quantity);
    await expect(admission.runListing(scope,currentPlan,listingHttp)).resolves.toBe(13);
    expect(listingHttp).toHaveBeenCalledExactlyOnceWith(13);

    async function acceptOne(orderId:number,lineId:number) {
      await database.pool.query("INSERT INTO oms.oms_orders(id,status) VALUES($1,'pending')",[orderId]);
      await database.pool.query(`INSERT INTO oms.oms_order_lines(id,order_id,product_variant_id,sku,requires_shipping,quantity,authority_fulfillable_quantity,wms_materialized_quantity,authorization_status)
        VALUES($1,$2,101,'P5',true,1,1,1,'authorized')`,[lineId,orderId]);
      await database.pool.query(`INSERT INTO wms.orders(id,warehouse_id,warehouse_status,on_hold,channel_id,source,external_order_id,oms_fulfillment_order_id,fulfillment_partition_key)
        VALUES($1,1,'ready',0,36,'shopify',$2,$3,'default')`,[orderId,`example-${orderId}`,`fo-${orderId}`]);
      await database.pool.query(`INSERT INTO wms.order_items(id,order_id,oms_order_line_id,source_item_id,sku,product_id,quantity,picked_quantity,fulfilled_quantity,status,on_hold,requires_shipping)
        VALUES($1::integer,$2,$1::bigint,$3,'P5',101,1,0,0,'pending',false,1)`,[lineId,orderId,`source-${lineId}`]);
      await new PostgresInventoryAvailabilityClaimRepository(new PostgresCanonicalClaimInventoryRepository(),database.pool,() => now)
        .claimOrder({ orderId,idempotencyKey:`composition-admission-demand-${orderId}`,actor:"operator",reason:"New accepted order validates current publication leases" });
    }
    await acceptOne(4,14);
    const planned=await currentPlan();
    expect(planned.quantity).toBe(12);
    now=new Date(planned.availableAt.getTime()+10);
    const store=new PostgresInventoryPublicationOutboxRepository(database.pool);
    const leases=await store.claimDue({ batchSize:1,leaseSeconds:30,leaseToken:"composition-exact-lease",now });
    expect(leases).toHaveLength(1);
    const leased=leases[0];
    expect(leased.desiredQuantity).toBe("12");
    const provider=vi.fn(async () => ({ published:true }));
    await expect(admission.runOutbox({ ...leased,leaseToken:"forged-token" },provider))
      .rejects.toMatchObject({ code:"PUBLICATION_OUTBOX_AUTHORIZATION_INVALID" });
    const expiredAdmission=new PostgresQuantityPublicationAdmission(database.pool,() => new Date(now.getTime()+31_000),
      () => "00000000-0000-4000-8000-000000000099");
    await expect(expiredAdmission.runOutbox(leased,provider)).rejects.toMatchObject({ code:"PUBLICATION_OUTBOX_AUTHORIZATION_INVALID" });
    await acceptOne(5,15);
    expect((await currentPlan()).quantity).toBe(11);
    await expect(admission.runOutbox(leased,provider)).rejects.toMatchObject({ code:"PUBLICATION_OUTBOX_AUTHORIZATION_INVALID" });
    expect(provider).not.toHaveBeenCalled();
  },20_000);
});
