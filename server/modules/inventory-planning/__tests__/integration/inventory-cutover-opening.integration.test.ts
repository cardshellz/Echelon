import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpeningSource, OpeningVerification } from "@shared/types/inventory-cutover-opening";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql, cutoverCompositionSeedSql, cutoverCompositionChannelSeedSql, installCutoverCompositionMigrations, seedCompositionReviewedDryRun } from "../fixtures/inventory-cutover-composition-database.fixture";
import { installCutoverAdmissionFixturePrerequisites } from "../fixtures/inventory-cutover-admission.fixture";
import { InventoryCutoverOpeningService } from "../../application/inventory-cutover-opening.service";
import { PostgresInventoryCutoverOpeningRepository } from "../../infrastructure/inventory-cutover-opening.repository";
import { PostgresInventoryCutoverReconstructionRepository } from "../../infrastructure/inventory-cutover-reconstruction.repository";
import { loadLatestCutoverOpening } from "../../infrastructure/inventory-cutover-opening.reader";
import { InventoryAvailabilityActivationService } from "../../application/inventory-availability-activation.service";
import { PostgresInventoryAvailabilityActivationRepository, selectedSnapshots } from "../../infrastructure/inventory-availability-activation.repository";
import { InventoryCutoverCommitService } from "../../application/inventory-cutover-commit.service";
import { PostgresInventoryCutoverCommitRepository } from "../../infrastructure/inventory-cutover-commit.repository";
import { projectInventoryCutoverStateInsideTransaction } from "../../infrastructure/inventory-cutover-projection.repository";
import { buildInventoryCutoverManifest } from "../../domain/inventory-cutover-manifest";
import { acquireInventoryCutoverFenceInsideTransaction } from "../../infrastructure/inventory-cutover-admission-fence.repository";
import { installQuantityCutoverFixture } from "../fixtures/inventory-quantity-cutover.fixture";
import { planCutoverReconstruction } from "../../domain/inventory-cutover-reconstruction";
import { PostgresInventoryPublicationOutboxRepository } from "../../infrastructure/inventory-publication-outbox.repository";
import { InventoryPublicationOutboxService } from "../../application/inventory-publication-outbox.service";
import { InventoryPublicationTransportRegistry } from "../../application/inventory-publication-transport";
import { PostgresQuantityPublicationAdmission } from "../../infrastructure/quantity-publication-admission.repository";
import { PostgresInventoryOpeningReservationRepository } from "../../../inventory/infrastructure/inventory-opening-reservation.repository";

vi.mock("../../../../db", () => ({ pool: {} }));
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = databaseUrl && disposable ? describe : describe.skip;
const NOW = new Date("2026-09-09T16:00:00Z");

function verification(source: OpeningSource): OpeningVerification {
  return { contractVersion: "inventory_cutover_opening_v1", expectedEvidenceHash: source.evidenceHash,
    expectedAuthorityRevision: source.authorityRevision, expectedConfigurationRunId: source.configurationRunId,
    verificationReference: "Independent warehouse count and open order review", verificationEvidenceHash: "c".repeat(64),
    verifiedAt: "2026-09-09T15:00:00Z", historicalDisposition: "preserve_unresolved",
    levels: source.evidence.levels, lots: source.evidence.lots,
    owners: [{ orderId: 1, orderItemId: 11, remainingQty: "6", reservedQty: "3", pickedQty: "2",
      allocations: [{ inventoryLevelId: 10, lots: [{ inventoryLotId: 4, reservedQty: "3", pickedQty: "2", originalCostIds: [9] }] }] }] };
}

dbDescribe.sequential("verified opening persistence with real PostgreSQL admission", () => {
  let database: InventoryCutoverTestDatabase;
  let pool: Pool;
  let store: PostgresInventoryCutoverOpeningRepository;
  let service: InventoryCutoverOpeningService;
  beforeEach(async () => {
    await database?.close();
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, cutoverCompositionBaseSql);
    pool = database.pool;
    await installCutoverCompositionMigrations(pool);
    await pool.query(cutoverCompositionSeedSql);
    await installCutoverAdmissionFixturePrerequisites(pool);
    await pool.query(readFileSync(resolve(process.cwd(), "migrations/236_inventory_cutover_admission.sql"), "utf8"));
    await pool.query(readFileSync(resolve(process.cwd(), "migrations/240_inventory_cutover_verified_opening.sql"), "utf8"));
    await installQuantityCutoverFixture(pool);
    await pool.query(`UPDATE wms.orders SET order_number='#OPENING-1';
      UPDATE warehouse.warehouses SET code='MAIN',name='Main warehouse';
      UPDATE warehouse.warehouse_locations SET code='PICK-A',name='Pick bin';
      UPDATE inventory.inventory_transactions SET reserved_qty_delta=NULL WHERE transaction_type='pick';
      INSERT INTO oms.channel_fulfillment_receipts(id,processing_status,source_provider,source_channel_id,
        source_order_id,source_fulfillment_id,oms_order_id,physical_shipment_id,attempt_count,raw_payload)
        VALUES(1,'ignored','shopify',36,'example-1','fulfillment-1',500,700,1,'{"historical":true}');
      INSERT INTO oms.channel_fulfillment_receipt_attempts(receipt_id,attempt_number,outcome,metadata)
        VALUES(1,1,'ignored','{"sourceEcho":true}')`);
    store = new PostgresInventoryCutoverOpeningRepository(pool);
    service = new InventoryCutoverOpeningService(store, { now: () => NOW });
  }, 30_000);
  afterAll(async () => { await database?.close(); });

  async function request(key = "opening-1") {
    const source = await service.capture("operator");
    return { verification: verification(source), reason: "Verified current inventory and all open commitments", idempotencyKey: key };
  }
  it.each(["fence", "proof", "counter", "lot", "invalid", "duplicate"])("rejects a counter translation with invalid %s evidence", async kind => {
    await pool.query("UPDATE inventory.inventory_levels SET reserved_qty=69 WHERE id=10");
    const input = await request(`mixed-${kind}`); input.verification.reservationBasis = "verified_current_lot_custody";
    const assessment = await service.preview(input.verification, "operator");
    const saved = await service.save(input, "operator");
    const before = await immutableBusinessState();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (kind !== "fence") await acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority: "legacy", expectedConfigurationRunId: null });
      if (kind === "counter") await client.query("UPDATE inventory.inventory_levels SET reserved_qty=68 WHERE id=10");
      if (kind === "lot") await client.query("UPDATE inventory.inventory_lots SET qty_reserved=2 WHERE id=4");
      const rows = assessment.plan.openingReservationRebases!;
      const command = { expectedEvidenceHash: assessment.plan.evidenceHash, activationRunId: "1", runtimeAuthorityRevision: "1",
        actor: "operator", reason: "Verify exact proof rejection", occurredAt: NOW.toISOString() };
      const expected = kind === "fence" ? "OPENING_REBASE_DATABASE_ERROR" : kind === "proof" ? "OPENING_REBASE_PROOF_CHANGED"
        : kind === "invalid" ? "OPENING_REBASE_INPUT_INVALID" : kind === "duplicate" ? "OPENING_REBASE_DUPLICATE" : "OPENING_REBASE_POSITION_CHANGED";
      await expect(new PostgresInventoryOpeningReservationRepository().translate({ client, command,
        snapshotId: saved.id, sourceEvidenceHash: kind === "proof" ? "f".repeat(64) : assessment.sourceEvidenceHash,
        rebases: kind === "invalid" ? [{ ...rows[0], physicalReservedQty: "-1" }] : kind === "duplicate" ? [...rows, ...rows] : rows,
      })).rejects.toMatchObject({ code: expected });
    } finally { await client.query("ROLLBACK"); client.release(); }
    expect(await immutableBusinessState()).toEqual(before);
  });
  it.each(["inventory_cutover_opening_v1", "inventory_cutover_opening_v2"] as const)("translates verified mixed-bin counters atomically and replays after a late rollback (%s)", async contractVersion => {
    await pool.query("UPDATE inventory.inventory_levels SET reserved_qty=69 WHERE id=10");
    const input = await request("mixed-opening"); input.verification.reservationBasis = "verified_current_lot_custody";
    input.verification.contractVersion = contractVersion;
    const before = await immutableBusinessState();
    const assessment = await service.preview(input.verification, "operator");
    expect(assessment).toMatchObject({ ready: true, plan: { legacyPromiseReleases: [],
      openingReservationRebases: [{ inventoryLevelId: 10, reservedQty: "69", physicalReservedQty: "3", variantQty: "20", pickedQty: "2" }] } });
    const saved = await service.save(input, "operator"); expect(await immutableBusinessState()).toEqual(before);
    expect((await loadLatestCutoverOpening(pool))?.assessment.plan.openingReservationRebases).toEqual(assessment.plan.openingReservationRebases);
    const dryRun = await seedCompositionReviewedDryRun(pool), clock = { now: () => new Date(dryRun.completedAt) };
    const activation = new InventoryAvailabilityActivationService(new PostgresInventoryAvailabilityActivationRepository(pool), clock);
    const prepared = await activation.prepare({ sourceDryRunId: dryRun.activationRunId, expectedDryRunResultHash: dryRun.resultHash,
      idempotencyKey: "mixed-prepare", reason: "Prepare verified mixed-bin custody" }, "operator");
    const cutover = new InventoryCutoverCommitService(new PostgresInventoryCutoverCommitRepository(pool), clock);
    const review = await cutover.preview({ activationRunId: prepared.activationRunId }, "operator");
    expect(review.ready).toBe(true); expect(review.summary.openingReservationRebases).toEqual(assessment.plan.openingReservationRebases);
    const command = { activationRunId: prepared.activationRunId, expectedAuthorityRevision: review.authorityRevision,
      expectedReviewHash: review.reviewHash, idempotencyKey: "mixed-commit", reason: "Preserve custody and remaining demand" };
    const beforeFailure = await immutableBusinessState();
    await pool.query(`CREATE FUNCTION public.fail_mixed_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'mixed late failure'; END $$;
      CREATE TRIGGER zz_mixed_failure BEFORE INSERT ON inventory.availability_cutover_commits FOR EACH ROW EXECUTE FUNCTION public.fail_mixed_receipt()`);
    await expect(cutover.commit(command, "operator")).rejects.toThrow("mixed late failure");
    expect(await immutableBusinessState()).toEqual(beforeFailure);
    await pool.query("DROP TRIGGER zz_mixed_failure ON inventory.availability_cutover_commits; DROP FUNCTION public.fail_mixed_receipt()");
    const outcomes = await Promise.all([cutover.commit(command, "operator"), cutover.commit(command, "operator")]);
    expect(outcomes.map(row => row.alreadyApplied).sort()).toEqual([false, true]);
    expect((await pool.query("SELECT variant_qty,reserved_qty,picked_qty FROM inventory.inventory_levels WHERE id=10")).rows)
      .toEqual([{ variant_qty: 20, reserved_qty: 4, picked_qty: 2 }]);
    expect((await pool.query("SELECT qty_on_hand,qty_reserved,qty_picked FROM inventory.inventory_lots WHERE id=4")).rows)
      .toEqual([{ qty_on_hand: 20, qty_reserved: 4, qty_picked: 2 }]);
    expect((await pool.query("SELECT reserved_qty_delta,variant_qty_delta,order_id,order_item_id FROM inventory.inventory_transactions WHERE reference_type='availability_opening_rebase'")).rows)
      .toEqual([{ reserved_qty_delta: -66, variant_qty_delta: 0, order_id: null, order_item_id: null }]);
    const receipt = (await pool.query("SELECT result_payload FROM inventory.availability_cutover_reconstruction_receipts")).rows[0].result_payload;
    expect(receipt.openingBalance.snapshotId).toBe(saved.id); expect(receipt.openingReservationRebaseTransactionIds).toHaveLength(1);
    expect((await pool.query("SELECT on_hand::text,reserved::text,picked::text FROM inventory.quantity_level_balances WHERE inventory_level_id=10")).rows)
      .toEqual([{ on_hand: "20", reserved: "4", picked: "2" }]);
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.quantity_commands WHERE kind='opening'")).rows).toEqual([{ count: 1 }]);
    const after = await immutableBusinessState();
    for (const field of ["costs", "orders", "items", "build_reservations", "build_demands", "receipts", "receipt_attempts"]) expect(after[field]).toEqual(beforeFailure[field]);
  }, 30_000);

  async function immutableBusinessState() {
    return (await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(row) ORDER BY id)::text FROM inventory.inventory_levels row) AS levels,
      (SELECT jsonb_agg(to_jsonb(row) ORDER BY id)::text FROM inventory.inventory_lots row) AS lots,
      (SELECT jsonb_agg(to_jsonb(row) ORDER BY id)::text FROM inventory.inventory_transactions row) AS journals,
      (SELECT jsonb_agg(to_jsonb(row) ORDER BY id)::text FROM oms.order_item_costs row) AS costs,
      (SELECT jsonb_agg(to_jsonb(row) ORDER BY id)::text FROM wms.orders row) AS orders,
      (SELECT jsonb_agg(to_jsonb(row) ORDER BY id)::text FROM wms.order_items row) AS items,
      (SELECT jsonb_agg(to_jsonb(row) ORDER BY id)::text FROM inventory.build_component_reservations row) AS build_reservations,
      (SELECT jsonb_agg(to_jsonb(row) ORDER BY id)::text FROM wms.order_build_demands row) AS build_demands,
      (SELECT jsonb_agg(to_jsonb(row) ORDER BY id)::text FROM oms.channel_fulfillment_receipts row) AS receipts,
      (SELECT jsonb_agg(to_jsonb(row) ORDER BY id)::text FROM oms.channel_fulfillment_receipt_attempts row) AS receipt_attempts,
      (SELECT count(*)::text FROM inventory.availability_claims) AS claims,
      (SELECT count(*)::text FROM inventory.inventory_publication_outbox) AS publications,
      (SELECT count(*)::text FROM inventory.quantity_commands) AS quantity_commands,
      (SELECT count(*)::text FROM inventory.quantity_entries) AS quantity_entries,
      (SELECT count(*)::text FROM inventory.quantity_ledger_opening) AS quantity_openings,
      (SELECT to_jsonb(row)::text FROM inventory.availability_runtime_authority row WHERE singleton_key=true) AS authority`)).rows[0];
  }

  async function seedOpeningPromise() {
    // Keep the fixture's unrelated unknown pick delta and ignored receipt: the
    // opening is still required. Only the new empty position has complete proof.
    await pool.query(`INSERT INTO wms.orders(id,warehouse_id,warehouse_status,on_hold,channel_id,source,
        external_order_id,oms_fulfillment_order_id,fulfillment_partition_key,order_number)
      VALUES(2,1,'ready',0,36,'shopify','example-2','fo-2','default','#PROMISE-2');
      INSERT INTO wms.order_items(id,order_id,oms_order_line_id,source_item_id,sku,product_id,quantity,
        picked_quantity,fulfilled_quantity,status,on_hold,requires_shipping,location)
      VALUES(22,2,22,'source-22','P5',101,20,0,0,'pending',false,1,'EMPTY');
      INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code) VALUES(200,1,'EMPTY');
      INSERT INTO inventory.inventory_levels(id,warehouse_location_id,product_variant_id,variant_qty,reserved_qty,picked_qty,packed_qty)
        VALUES(20,200,101,0,20,0,0);
      INSERT INTO inventory.inventory_transactions(order_id,order_item_id,product_variant_id,to_location_id,transaction_type,
        variant_qty_delta,variant_qty_before,variant_qty_after,reserved_qty_delta,source_state,target_state)
        VALUES(2,22,101,200,'reserve',0,0,0,20,'on_hand','committed');
      UPDATE inventory.inventory_levels SET reserved_qty=4 WHERE id=10;
      UPDATE inventory.inventory_lots SET qty_reserved=4 WHERE id=4;
      INSERT INTO inventory.build_orders(id,status,warehouse_id) VALUES(7,'released',1);
      INSERT INTO inventory.build_order_components(id,build_order_id,component_variant_id,source_location_id) VALUES(8,7,101,100);
      INSERT INTO inventory.build_component_reservations(id,build_order_component_id,inventory_lot_id,reserved_qty,
        consumed_qty,released_qty,reservation_owner,availability_claim_id,availability_claim_lot_allocation_id)
        VALUES(9,8,4,1,0,0,'build_order',NULL,NULL)`);
  }

  async function promiseOpeningRequest(contractVersion: OpeningVerification["contractVersion"] = "inventory_cutover_opening_v1") {
    const source = await service.capture("operator");
    const input = { verification: verification(source), reason: "Verify physical custody and preserve the complete unfilled promise",
      idempotencyKey: "promise-opening" };
    input.verification.contractVersion = contractVersion;
    input.verification.owners.push({ orderId: 2, orderItemId: 22, remainingQty: "20", reservedQty: "0", pickedQty: "0", allocations: [] });
    return { source, input };
  }

  async function prepareOpeningPromiseCutover() {
    const dryRun = await seedCompositionReviewedDryRun(pool);
    const now = new Date(Date.parse(dryRun.completedAt) + 10);
    const clock = { now: () => now };
    const activation = new InventoryAvailabilityActivationService(new PostgresInventoryAvailabilityActivationRepository(pool), clock);
    const prepared = await activation.prepare({ sourceDryRunId: dryRun.activationRunId, expectedDryRunResultHash: dryRun.resultHash,
      idempotencyKey: "promise-opening-prepare", reason: "Prepare verified physical custody and exact unfilled demand" }, "operator");
    if (prepared.state === "publishing") {
      // Only this in-memory transport represents the external provider. All
      // publication leases, admission and persisted readbacks use real owners.
      let observed = 20;
      const transports = new InventoryPublicationTransportRegistry();
      transports.register({ destinationKind: "channel_connection", providerKey: "shopify", supportedScopeTypes: ["location"],
        publishAbsolute: async request => { observed = request.desiredQuantity; return { publishedQuantity: observed, providerResponse: { testOnly: true } }; },
        readAbsolute: async () => ({ observedQuantity: observed, providerResponse: { testOnly: true } }) });
      const publisher = new InventoryPublicationOutboxService(new PostgresInventoryPublicationOutboxRepository(pool), transports,
        clock, () => "promise-opening-lease", new PostgresQuantityPublicationAdmission(pool, () => now,
          () => "00000000-0000-4000-8000-000000000041"));
      expect(await publisher.processDue({ batchSize: 1, leaseSeconds: 60 })).toEqual({ claimed: 1, verified: 1, failed: 0, superseded: 0 });
    } else expect(prepared.state).toBe("publication_verified");
    const cutover = new InventoryCutoverCommitService(new PostgresInventoryCutoverCommitRepository(pool), clock);
    const review = await cutover.preview({ activationRunId: prepared.activationRunId }, "operator");
    expect(review).toMatchObject({ ready: true, blockers: [], summary: {
      orders: 2, lines: 2, retainedIndependentBuildHolds: 1, legacyPromiseReplanning: { positions: 1, orderLines: 1 } } });
    return { cutover, review, command: { activationRunId: prepared.activationRunId, expectedAuthorityRevision: review.authorityRevision,
      expectedReviewHash: review.reviewHash, idempotencyKey: "promise-opening-cutover", reason: "Atomically replace the exact promise with fully retained demand" } };
  }

  async function expectSupplementalCensusWritersBlocked() {
    // A new pending receipt must not appear between the owner capture and its
    // audit/commit. Cover attempts separately: they change latest-echo evidence.
    for (const sql of [
      "INSERT INTO oms.channel_fulfillment_receipts(id,processing_status) VALUES(2,'pending')",
      "UPDATE oms.channel_fulfillment_receipts SET processing_status='pending' WHERE id=1",
      "DELETE FROM oms.channel_fulfillment_receipts WHERE false",
      "INSERT INTO oms.channel_fulfillment_receipt_attempts(receipt_id,attempt_number,outcome,metadata) VALUES(1,2,'review','{}')",
      "UPDATE oms.channel_fulfillment_receipt_attempts SET metadata='{}' WHERE receipt_id=1",
      "DELETE FROM oms.channel_fulfillment_receipt_attempts WHERE false",
      "INSERT INTO wms.order_build_demands(id,order_id,order_item_id,target_variant_id,status,requested_qty,promised_qty) VALUES(1,1,11,101,'planning',1,0)",
      "UPDATE wms.order_build_demands SET status='planning' WHERE false",
      "DELETE FROM wms.order_build_demands WHERE false",
    ]) await expect(pool.query(sql)).rejects.toMatchObject({ code: "55P03" });
  }

  it("installs all three supplemental capture pins after the real77-scope admission migration", async () => {
    const rows = (await pool.query(`SELECT namespace.nspname||'.'||relation.relname AS relation
      FROM pg_trigger trigger JOIN pg_class relation ON relation.oid=trigger.tgrelid
      JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE trigger.tgname='aa_cutover_writer_admission' ORDER BY namespace.nspname,relation.relname`)).rows;
    expect(rows).toHaveLength(83); // prior80 plus quantity commands, entries and durable operation replies
    expect(rows).toEqual(expect.arrayContaining([
      { relation: "oms.channel_fulfillment_receipts" }, { relation: "oms.channel_fulfillment_receipt_attempts" },
      { relation: "wms.order_build_demands" },
    ]));
  });

  it("captures human identifiers and all facts in one read-only transaction without persisting evidence", async () => {
    const client = await pool.connect(); const trace = vi.spyOn(client, "query");
    const isolated = new InventoryCutoverOpeningService(new PostgresInventoryCutoverOpeningRepository({ connect: async () => client } as Pick<Pool,"connect">), { now: () => NOW });
    try {
      const source = await isolated.capture("operator");
      expect(source).toMatchObject({ runtimeAuthority: "legacy", authorityRevision: "1", configurationRunId: null, latestVerification: null });
      expect(source.labels).toEqual(expect.arrayContaining([
        { kind: "order", id: "1", label: "#OPENING-1" }, { kind: "variant", id: "101", label: "P5" },
        { kind: "warehouse", id: "1", label: "MAIN - Main warehouse" }, { kind: "location", id: "100", label: "PICK-A - Pick bin" },
      ]));
      const statements = trace.mock.calls.map(([sql]) => String(sql));
      expect(statements[0]).toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      expect(statements.at(-1)).toBe("COMMIT");
      expect(statements.some(sql => /\b(?:INSERT|UPDATE|DELETE|nextval)\b/i.test(sql))).toBe(false);
    } finally { trace.mockRestore(); }
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.availability_cutover_opening_snapshots")).rows[0].count).toBe(0);
  });

  it("records independent exact facts and preserved historical exceptions without changing stock, costs, orders or authority", async () => {
    const input = await request(); const before = await immutableBusinessState();
    const preview = await service.preview(input.verification, "operator");
    expect(preview).toMatchObject({ ready: true, blockers: [] });
    expect(preview.historicalExceptions.length).toBeGreaterThan(0);
    expect(preview.historicalExceptions).toContainEqual(expect.objectContaining({ code: "SHIPMENT_ACKNOWLEDGMENT_REQUIRES_INVENTORY_RECONCILIATION" }));
    expect(preview.historicalExceptions.some(row => row.subject.startsWith("journal:") || row.subject.startsWith("order-item:"))).toBe(true);
    const saved = await service.save(input, "operator");
    expect(saved).toMatchObject({ sourceEvidenceHash: input.verification.expectedEvidenceHash,
      authorityRevision: "1", historicalExceptionCount: preview.historicalExceptions.length, actor: "operator",
      alreadyApplied: false, stockChanged: false, authorityChanged: false });
    expect(await immutableBusinessState()).toEqual(before);
    const persisted = await loadLatestCutoverOpening(pool);
    expect(persisted).toMatchObject({ saved, verification: input.verification, assessment: preview });
    expect((await service.capture("operator")).latestVerification).toEqual(saved);
  });

  it.each(["inventory_cutover_opening_v1", "inventory_cutover_opening_v2"] as const)("%s carries empty-bin proof through opening, publication and atomic handoff without losing custody or demand", async contractVersion => {
    await seedOpeningPromise();
    await pool.query(cutoverCompositionChannelSeedSql);
    const { source, input } = await promiseOpeningRequest(contractVersion);
    const strict = planCutoverReconstruction(source.evidence);
    expect(strict.ready).toBe(false);
    expect(strict.blockers).toContainEqual(expect.objectContaining({ code: "JOURNAL_CUSTODY_UNKNOWN" }));
    expect(strict.legacyPromiseReleases).toMatchObject([{ inventoryLevelId: 20, reservedQty: "20",
      owners: [{ orderId: 2, orderItemId: 22, reservedQty: "20" }] }]);
    const beforeOpening = await immutableBusinessState();
    const assessment = await service.preview(input.verification, "operator");
    expect(assessment).toMatchObject({ ready: true, blockers: [], plan: {
      retainedIndependentBuildReservationIds: [9], legacyPromiseReleases: strict.legacyPromiseReleases,
      orders: [{ orderId: 1, lines: [{ orderItemId: 11, requestedQty: "6", reservedQty: "3", pickedQty: "2", freshDemandQty: "1" }] },
        { orderId: 2, lines: [{ orderItemId: 22, requestedQty: "20", reservedQty: "0", pickedQty: "0", freshDemandQty: "20", allocations: [] }] }] } });
    expect(assessment.historicalExceptions).toContainEqual(expect.objectContaining({ code: "JOURNAL_CUSTODY_UNKNOWN" }));
    expect(await immutableBusinessState()).toEqual(beforeOpening);
    const saves = await Promise.all([service.save(input, "operator"), service.save(input, "operator")]);
    expect(saves.map(row => row.alreadyApplied).sort()).toEqual([false, true]);
    expect(saves[0].id).toBe(saves[1].id);
    expect(await immutableBusinessState()).toEqual(beforeOpening);
    const persistedOpening = await loadLatestCutoverOpening(pool);
    expect(persistedOpening?.assessment.plan.legacyPromiseReleases).toEqual(strict.legacyPromiseReleases);

    const { cutover, review, command } = await prepareOpeningPromiseCutover();
    expect(review.summary.openingBalance).toMatchObject({ snapshotId: saves[0].id });
    expect(review.publicationRows).toEqual([{ publicationTargetId: 1, productVariantId: 101, desiredQuantity: "0" }]);
    const beforeCommit = await immutableBusinessState();
    const publicationBefore = (await pool.query("SELECT to_jsonb(row) AS row FROM inventory.inventory_publication_outbox row ORDER BY id")).rows;
    expect(beforeCommit.levels).toBe(beforeOpening.levels);
    expect(beforeCommit.lots).toBe(beforeOpening.lots);
    expect(beforeCommit.claims).toBe("0");
    await pool.query(`CREATE FUNCTION public.fail_opening_promise_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test opening promise final receipt failure'; END $$;
      CREATE TRIGGER zz_opening_promise_receipt_failure BEFORE INSERT ON inventory.availability_cutover_commits
        FOR EACH ROW EXECUTE FUNCTION public.fail_opening_promise_receipt()`);
    try { await expect(cutover.commit(command, "operator")).rejects.toThrow("test opening promise final receipt failure"); }
    finally { await pool.query("DROP TRIGGER zz_opening_promise_receipt_failure ON inventory.availability_cutover_commits; DROP FUNCTION public.fail_opening_promise_receipt()"); }
    expect(await immutableBusinessState()).toEqual(beforeCommit);
    expect((await pool.query("SELECT to_jsonb(row) AS row FROM inventory.inventory_publication_outbox row ORDER BY id")).rows).toEqual(publicationBefore);
    for (const table of ["availability_claim_pick_movements", "availability_cutover_reconstruction_receipts", "availability_cutover_commits"]) {
      expect((await pool.query(`SELECT count(*)::integer AS count FROM inventory.${table}`)).rows[0].count).toBe(0);
    }
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.inventory_transactions WHERE reference_type='inventory_cutover_promise'")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT lifecycle_status FROM inventory.transformation_model_versions")).rows).toEqual([{ lifecycle_status: "draft" }]);
    expect((await pool.query("SELECT state FROM inventory.inventory_publication_targets")).rows).toEqual([{ state: "preview" }]);
    expect(await loadLatestCutoverOpening(pool)).toEqual(persistedOpening);

    const results = await Promise.all([cutover.commit(command, "operator"), cutover.commit(command, "operator")]);
    expect(results.map(row => row.alreadyApplied).sort()).toEqual([false, true]);
    expect(await cutover.commit(command, "operator")).toMatchObject({ alreadyApplied: true, runtimeAuthority: "canonical" });
    expect((await pool.query("SELECT id,variant_qty,reserved_qty,picked_qty,packed_qty FROM inventory.inventory_levels ORDER BY id")).rows)
      .toEqual([{ id: 10, variant_qty: 20, reserved_qty: 20, picked_qty: 2, packed_qty: 0 },
        { id: 20, variant_qty: 0, reserved_qty: 0, picked_qty: 0, packed_qty: 0 }]);
    expect((await pool.query("SELECT qty_on_hand,qty_reserved,qty_picked,total_unit_cost_mills::text FROM inventory.inventory_lots WHERE id=4")).rows)
      .toEqual([{ qty_on_hand: 20, qty_reserved: 20, qty_picked: 2, total_unit_cost_mills: "9007199254740995" }]);
    expect((await pool.query("SELECT order_item_id,requested_qty::text,planned_qty::text,shortfall_qty::text FROM inventory.availability_claim_lines ORDER BY order_item_id")).rows)
      .toEqual([{ order_item_id: 11, requested_qty: "6", planned_qty: "6", shortfall_qty: "0" },
        { order_item_id: 22, requested_qty: "20", planned_qty: "15", shortfall_qty: "5" }]);
    expect((await pool.query("SELECT order_id,order_item_id,reserved_qty_delta,variant_qty_delta,from_location_id FROM inventory.inventory_transactions WHERE reference_type='inventory_cutover_promise'")).rows)
      .toEqual([{ order_id: 2, order_item_id: 22, reserved_qty_delta: -20, variant_qty_delta: 0, from_location_id: 200 }]);
    expect((await pool.query("SELECT result_payload->'legacyPromiseReleases' AS releases,jsonb_array_length(result_payload->'legacyPromiseReleaseTransactionIds') AS audits FROM inventory.availability_cutover_reconstruction_receipts")).rows)
      .toEqual([{ releases: strict.legacyPromiseReleases, audits: 1 }]);
    expect((await pool.query("SELECT quantity::text,total_cost_mills::text,order_item_cost_id FROM inventory.availability_claim_pick_movements")).rows)
      .toEqual([{ quantity: "2", total_cost_mills: "18014398509481990", order_item_cost_id: 9 }]);
    expect((await pool.query("SELECT desired_quantity::text FROM inventory.inventory_publication_outbox WHERE publication_phase='full'")).rows)
      .toEqual([{ desired_quantity: "0" }]);
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.availability_cutover_commits")).rows[0].count).toBe(1);
    const after = await immutableBusinessState();
    for (const field of ["costs", "orders", "items", "build_reservations", "build_demands", "receipts", "receipt_attempts"] as const) {
      expect(after[field]).toEqual(beforeOpening[field]);
    }
    expect((await pool.query("SELECT jsonb_agg(to_jsonb(row) ORDER BY id)::text AS journals FROM inventory.inventory_transactions row WHERE id IN (1,2,3)")).rows[0].journals)
      .toBe(beforeOpening.journals);
    expect(await loadLatestCutoverOpening(pool)).toEqual(persistedOpening);
  }, 30_000);

  it.each(["remaining", "reserved"])("blocks a verified promise owner with altered %s quantity without releasing anything", async field => {
    await seedOpeningPromise();
    const { input } = await promiseOpeningRequest();
    if (field === "remaining") input.verification.owners[1].remainingQty = "19";
    else input.verification.owners[1].reservedQty = "20";
    const before = await immutableBusinessState();
    const assessment = await service.preview(input.verification, "operator");
    expect(assessment).toMatchObject({ ready: false, plan: { orders: [], legacyPromiseReleases: [] } });
    expect(assessment.blockers).toContainEqual(expect.objectContaining({ code: "OPENING_PROMISE_OWNER_MISMATCH", subject: "order-item:22" }));
    await expect(service.save(input, "operator")).rejects.toMatchObject({ code: "CUTOVER_OPENING_BLOCKED" });
    expect(await immutableBusinessState()).toEqual(before);
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.availability_cutover_opening_snapshots")).rows[0].count).toBe(0);
  });

  it.each(["journal", "counter"])("blocks a saved opening promise after its %s changes before the atomic commit", async field => {
    await seedOpeningPromise();
    const { input } = await promiseOpeningRequest();
    await service.save(input, "operator");
    const { cutover, command } = await prepareOpeningPromiseCutover();
    await pool.query(field === "journal"
      ? "UPDATE inventory.inventory_transactions SET notes='changed exact promise proof' WHERE order_item_id=22"
      : "UPDATE inventory.inventory_levels SET reserved_qty=19 WHERE id=20");
    const before = await immutableBusinessState();
    const stale = await cutover.preview({ activationRunId: command.activationRunId }, "operator");
    expect(stale.ready).toBe(false);
    expect(stale.blockers).toContainEqual(expect.objectContaining({ code: "CUTOVER_OPENING_EVIDENCE_CHANGED" }));
    await expect(cutover.commit(command, "operator")).rejects.toMatchObject({ code: "CUTOVER_REVIEW_BLOCKED" });
    expect(await immutableBusinessState()).toEqual(before);
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.inventory_transactions WHERE reference_type='inventory_cutover_promise'")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.availability_cutover_commits")).rows[0].count).toBe(0);
  }, 30_000);

  it("keeps missing original picked costs blocked instead of persisting a partial opening audit", async () => {
    await pool.query("DELETE FROM oms.order_item_costs WHERE id=9");
    const input = await request(); const before = await immutableBusinessState();
    const assessment = await service.preview(input.verification, "operator");
    expect(assessment.ready).toBe(false);
    expect(assessment.blockers).toContainEqual(expect.objectContaining({ code: "OPENING_PICK_COST_INVALID" }));
    await expect(service.save(input, "operator")).rejects.toMatchObject({ code: "CUTOVER_OPENING_BLOCKED" });
    expect(await immutableBusinessState()).toEqual(before);
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.availability_cutover_opening_snapshots")).rows[0].count).toBe(0);
  });

  it("requires the exact authority revision for both assessment and save", async () => {
    const input = await request(); input.verification.expectedAuthorityRevision = "2";
    await expect(service.preview(input.verification, "operator")).rejects.toMatchObject({ code: "CUTOVER_OPENING_AUTHORITY_CHANGED" });
    await expect(service.save(input, "operator")).rejects.toMatchObject({ code: "CUTOVER_OPENING_AUTHORITY_CHANGED" });
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.availability_cutover_opening_snapshots")).rows[0].count).toBe(0);
  });

  it("does not persist a partly fulfilled line that the current picker cannot safely adopt", async () => {
    await pool.query(`UPDATE wms.order_items SET picked_quantity=4,fulfilled_quantity=2 WHERE id=11;
      UPDATE inventory.inventory_levels SET reserved_qty=2 WHERE id=10;
      UPDATE inventory.inventory_lots SET qty_reserved=2 WHERE id=4`);
    const input = await request();
    input.verification.owners[0] = { ...input.verification.owners[0], remainingQty: "4", reservedQty: "2",
      allocations: [{ inventoryLevelId: 10, lots: [{ inventoryLotId: 4, reservedQty: "2", pickedQty: "2", originalCostIds: [9] }] }] };
    const before = await immutableBusinessState();
    const assessment = await service.preview(input.verification, "operator");
    expect(assessment).toMatchObject({ ready: false, plan: { orders: [] } });
    expect(assessment.blockers).toContainEqual(expect.objectContaining({ code: "OPENING_PARTIAL_FULFILLMENT_RUNTIME_UNSUPPORTED" }));
    await expect(service.save(input, "operator")).rejects.toMatchObject({ code: "CUTOVER_OPENING_BLOCKED" });
    expect(await immutableBusinessState()).toEqual(before);
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.availability_cutover_opening_snapshots")).rows[0].count).toBe(0);
  });

  it("does not hide an unshipped source by verifying its order line has zero remaining demand", async () => {
    await pool.query(`UPDATE wms.order_items SET picked_quantity=6,fulfilled_quantity=6 WHERE id=11;
      UPDATE inventory.inventory_levels SET reserved_qty=0,picked_qty=0 WHERE id=10;
      UPDATE inventory.inventory_lots SET qty_reserved=0,qty_picked=0 WHERE id=4;
      INSERT INTO wms.outbound_shipments(id,order_id,status) VALUES(50,1,'planned');
      INSERT INTO wms.outbound_shipment_items(id,shipment_id,order_item_id,product_variant_id,qty,from_location_id)
        VALUES(51,50,11,101,1,100)`);
    const input = await request();
    input.verification.owners[0] = { orderId: 1, orderItemId: 11, remainingQty: "0", reservedQty: "0", pickedQty: "0", allocations: [] };
    const before = await immutableBusinessState();
    const assessment = await service.preview(input.verification, "operator");
    expect(assessment).toMatchObject({ ready: false, plan: { orders: [] } });
    expect(assessment.blockers).toContainEqual(expect.objectContaining({ code: "OPENING_ZERO_REMAINING_PACKAGE_REQUIRES_REVIEW", subject: "source:51" }));
    await expect(service.save(input, "operator")).rejects.toMatchObject({ code: "CUTOVER_OPENING_BLOCKED" });
    expect(await immutableBusinessState()).toEqual(before);
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.availability_cutover_opening_snapshots")).rows[0].count).toBe(0);
  });

  it("rejects a changed configuration expectation before recording any audit", async () => {
    const input = await request(); input.verification.expectedConfigurationRunId = "999";
    await expect(service.preview(input.verification, "operator")).rejects.toMatchObject({ code: "CUTOVER_OPENING_AUTHORITY_CHANGED" });
    await expect(service.save(input, "operator")).rejects.toMatchObject({ code: "55000", message: "CUTOVER_CONFIGURATION_FREEZE_CHANGED" });
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.availability_cutover_opening_snapshots")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT authority,revision::text FROM inventory.availability_runtime_authority")).rows)
      .toEqual([{ authority: "legacy", revision: "1" }]);
  });

  it("uses the exact saved opening in actual publication projection and refuses stale evidence without a fallback", async () => {
    const input = await request(); const saved = await service.save(input, "operator");
    const dryRun = await seedCompositionReviewedDryRun(pool);
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const manifest = buildInventoryCutoverManifest(dryRun, await selectedSnapshots(client, dryRun, false));
      const projected = await projectInventoryCutoverStateInsideTransaction(client, manifest, dryRun.activationRunId, "1");
      expect(projected.blockers).toEqual([]);
      expect(projected.reconstruction).toMatchObject({ ready: true, legacyPromiseReleases: [], openingBalance: {
        snapshotId: saved.id, sourceEvidenceHash: saved.sourceEvidenceHash, historicalExceptionHash: saved.historicalExceptionHash,
      }, orders: [{ orderId: 1, lines: [{ orderItemId: 11, requestedQty: "6", reservedQty: "3", pickedQty: "2", freshDemandQty: "1" }] }] });
      expect(projected.publicationRows).toEqual([]);
    } finally { await client.query("ROLLBACK"); client.release(); }
    await pool.query("UPDATE inventory.inventory_transactions SET notes='changed historical source after verification' WHERE id=1");
    const stale = await pool.connect();
    try {
      await stale.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const plan = await new PostgresInventoryCutoverReconstructionRepository().preview(stale);
      expect(plan).toMatchObject({ ready: false, orders: [], legacyPromiseReleases: [] });
      expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "CUTOVER_OPENING_EVIDENCE_CHANGED", subject: `opening:${saved.id}` }));
    } finally { await stale.query("ROLLBACK"); stale.release(); }
    expect((await loadLatestCutoverOpening(pool))?.saved).toEqual(saved);
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.availability_claims")).rows[0].count).toBe(0);
  });

  it("does not consume a saved opening after an actual authority revision change even with identical source facts", async () => {
    const input = await request(); const saved = await service.save(input, "operator");
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority: "legacy", expectedConfigurationRunId: null });
      await client.query("UPDATE inventory.availability_runtime_authority SET revision=2 WHERE singleton_key=true");
      await client.query("COMMIT");
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const plan = await new PostgresInventoryCutoverReconstructionRepository().preview(client);
      expect(plan).toMatchObject({ ready: false, orders: [], legacyPromiseReleases: [] });
      expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "CUTOVER_OPENING_EVIDENCE_CHANGED" }));
    } finally { await client.query("ROLLBACK"); client.release(); }
    const source = await service.capture("operator");
    expect(source.evidenceHash).toBe(saved.sourceEvidenceHash);
    expect(source.authorityRevision).toBe("2");
    expect(source.runtimeAuthority).toBe("legacy");
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.availability_claims")).rows[0].count).toBe(0);
  });

  it("preserves customer and independent-build holds through full cutover, rolls back late failure, and adopts only existing costs", async () => {
    await pool.query(`UPDATE inventory.inventory_levels SET reserved_qty=4 WHERE id=10;
      UPDATE inventory.inventory_lots SET qty_reserved=4 WHERE id=4;
      INSERT INTO inventory.build_orders(id,status,warehouse_id) VALUES(7,'released',1);
      INSERT INTO inventory.build_order_components(id,build_order_id,component_variant_id,source_location_id) VALUES(8,7,101,100);
      INSERT INTO inventory.build_component_reservations(id,build_order_component_id,inventory_lot_id,reserved_qty,
        consumed_qty,released_qty,reservation_owner,availability_claim_id,availability_claim_lot_allocation_id)
        VALUES(9,8,4,1,0,0,'build_order',NULL,NULL)`);
    const input = await request();
    const assessment = await service.preview(input.verification, "operator");
    expect(assessment).toMatchObject({ ready: true, plan: { retainedIndependentBuildReservationIds: [9], legacyPromiseReleases: [] } });
    const saved = await service.save(input, "operator");
    const openingBefore = await loadLatestCutoverOpening(pool);
    const dryRun = await seedCompositionReviewedDryRun(pool);
    const clock = { now: () => new Date(dryRun.completedAt) };
    const activation = new InventoryAvailabilityActivationService(new PostgresInventoryAvailabilityActivationRepository(pool), clock);
    const prepared = await activation.prepare({ sourceDryRunId: dryRun.activationRunId, expectedDryRunResultHash: dryRun.resultHash,
      idempotencyKey: "opening-prepare", reason: "Prepare exact independently verified current custody" }, "operator");
    expect(prepared).toMatchObject({ state: "publication_verified", runtimeAuthority: "legacy" });
    const cutover = new InventoryCutoverCommitService(new PostgresInventoryCutoverCommitRepository(pool), clock);
    const review = await cutover.preview({ activationRunId: prepared.activationRunId }, "operator");
    expect(review).toMatchObject({ ready: true, blockers: [], summary: { retainedIndependentBuildHolds: 1,
      openingBalance: { snapshotId: saved.id, historicalExceptionCount: saved.historicalExceptionCount } } });
    const command = { activationRunId: prepared.activationRunId, expectedAuthorityRevision: review.authorityRevision,
      expectedReviewHash: review.reviewHash, idempotencyKey: "opening-cutover-commit", reason: "Adopt reviewed current custody without repairing history" };
    const beforeFailure = await immutableBusinessState();
    await pool.query(`CREATE FUNCTION public.fail_opening_final_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test opening final receipt failure'; END $$;
      CREATE TRIGGER zz_opening_final_receipt_failure BEFORE INSERT ON inventory.availability_cutover_commits
        FOR EACH ROW EXECUTE FUNCTION public.fail_opening_final_receipt()`);
    const capture = PostgresInventoryCutoverReconstructionRepository.prototype.capture;
    const guardedCapture = vi.spyOn(PostgresInventoryCutoverReconstructionRepository.prototype, "capture")
      .mockImplementation(async function (this: PostgresInventoryCutoverReconstructionRepository, client: PoolClient) {
        const evidence = await capture.call(this, client);
        await expectSupplementalCensusWritersBlocked();
        return evidence;
      });
    try {
      await expect(cutover.commit(command, "operator")).rejects.toThrow("test opening final receipt failure");
      expect(guardedCapture).toHaveBeenCalledTimes(2); // final review and adopted-claim recapture
    } finally {
      guardedCapture.mockRestore();
      await pool.query("DROP TRIGGER zz_opening_final_receipt_failure ON inventory.availability_cutover_commits; DROP FUNCTION public.fail_opening_final_receipt()");
    }
    expect(await immutableBusinessState()).toEqual(beforeFailure);
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.availability_claim_pick_movements")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.availability_cutover_reconstruction_receipts")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.availability_cutover_commits")).rows[0].count).toBe(0);
    expect(await loadLatestCutoverOpening(pool)).toEqual(openingBefore);
    expect((await pool.query("SELECT lifecycle_status FROM inventory.transformation_model_versions")).rows).toEqual([{ lifecycle_status: "draft" }]);
    const outcomes = await Promise.all([cutover.commit(command, "operator"), cutover.commit(command, "operator")]);
    expect(outcomes.map(row => row.alreadyApplied).sort()).toEqual([false, true]);
    expect((await pool.query("SELECT variant_qty,reserved_qty,picked_qty FROM inventory.inventory_levels WHERE id=10")).rows)
      .toEqual([{ variant_qty: 20, reserved_qty: 5, picked_qty: 2 }]);
    expect((await pool.query("SELECT qty_on_hand,qty_reserved,qty_picked,total_unit_cost_mills::text FROM inventory.inventory_lots WHERE id=4")).rows)
      .toEqual([{ qty_on_hand: 20, qty_reserved: 5, qty_picked: 2, total_unit_cost_mills: "9007199254740995" }]);
    expect((await pool.query("SELECT reserved_qty,consumed_qty,released_qty FROM inventory.build_component_reservations WHERE id=9")).rows)
      .toEqual([{ reserved_qty: 1, consumed_qty: 0, released_qty: 0 }]);
    expect((await pool.query("SELECT quantity::text,total_cost_mills::text,order_item_cost_id FROM inventory.availability_claim_pick_movements")).rows)
      .toEqual([{ quantity: "2", total_cost_mills: "18014398509481990", order_item_cost_id: 9 }]);
    const after = await immutableBusinessState();
    for (const field of ["costs", "orders", "items", "build_reservations", "build_demands", "receipts", "receipt_attempts"] as const) expect(after[field]).toEqual(beforeFailure[field]);
    expect((await pool.query("SELECT jsonb_agg(to_jsonb(row) ORDER BY id)::text AS journals FROM inventory.inventory_transactions row WHERE id IN (1,2)")).rows[0].journals)
      .toBe(beforeFailure.journals);
    expect((await pool.query("SELECT result_payload->'openingBalance' AS opening FROM inventory.availability_cutover_reconstruction_receipts")).rows)
      .toEqual([{ opening: expect.objectContaining({ snapshotId: saved.id, sourceEvidenceHash: saved.sourceEvidenceHash }) }]);
    expect(await loadLatestCutoverOpening(pool)).toEqual(openingBefore);
  }, 30_000);

  it("replays the exact command after later census changes, while preserving the original verified facts", async () => {
    const input = await request(); const saved = await service.save(input, "operator");
    await pool.query("UPDATE inventory.inventory_transactions SET notes='later original evidence' WHERE id=1");
    expect(await service.save(input, "operator")).toEqual({ ...saved, alreadyApplied: true });
    expect((await service.capture("operator")).evidenceHash).not.toBe(saved.sourceEvidenceHash);
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.availability_cutover_opening_snapshots")).rows[0].count).toBe(1);
  });

  it.each(["actor", "reason", "reference"])("rejects reuse of a command key with changed %s", async field => {
    const input = await request(); await service.save(input, "operator");
    const changed = field === "reason" ? { ...input, reason: "Different reason" }
      : field === "reference" ? { ...input, verification: { ...input.verification, verificationReference: "Different verification" } } : input;
    await expect(service.save(changed, field === "actor" ? "other" : "operator")).rejects.toMatchObject({ code: "CUTOVER_OPENING_IDEMPOTENCY_CONFLICT" });
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.availability_cutover_opening_snapshots")).rows[0].count).toBe(1);
  });

  it("rejects stale captures and incompatible current balances before recording any snapshot", async () => {
    const input = await request();
    await pool.query("UPDATE inventory.inventory_transactions SET notes='changed raw history' WHERE id=1");
    await expect(service.save(input, "operator")).rejects.toMatchObject({ code: expect.stringMatching(/^CUTOVER_OPENING_(BLOCKED|EVIDENCE_CHANGED)$/) });
    const fresh = await request("opening-fresh"); fresh.verification.levels[0].variantQty = "21";
    await expect(service.save(fresh, "operator")).rejects.toMatchObject({ code: "CUTOVER_OPENING_BLOCKED" });
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.availability_cutover_opening_snapshots")).rows[0].count).toBe(0);
  });

  it("serializes concurrent identical retries and produces one immutable snapshot", async () => {
    const input = await request();
    const results = await Promise.all([service.save(input, "operator"), service.save(input, "operator")]);
    expect(results.map(row => row.alreadyApplied).sort()).toEqual([false, true]);
    expect(results[0].id).toBe(results[1].id);
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.availability_cutover_opening_snapshots")).rows[0].count).toBe(1);
  });

  it("never permits competing keys to replace verification of the same source snapshot", async () => {
    const input = await request();
    const results = await Promise.allSettled([service.save(input, "operator"), service.save({ ...input, idempotencyKey: "competing-key" }, "operator")]);
    expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect(results.find(row => row.status === "rejected")).toMatchObject({ reason: { code: "CUTOVER_OPENING_ALREADY_VERIFIED" } });
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.availability_cutover_opening_snapshots")).rows[0].count).toBe(1);
  });

  it("database guards forbid mutation, deletion, truncation and an insertion without exclusive admission", async () => {
    await service.save(await request(), "operator");
    for (const sql of ["UPDATE inventory.availability_cutover_opening_snapshots SET reason=reason",
      "DELETE FROM inventory.availability_cutover_opening_snapshots", "TRUNCATE inventory.availability_cutover_opening_snapshots CASCADE"]) {
      await expect(pool.query(sql)).rejects.toMatchObject({ code: "23514" });
    }
    await expect(pool.query(`INSERT INTO inventory.availability_cutover_opening_snapshots OVERRIDING SYSTEM VALUE
      SELECT * FROM inventory.availability_cutover_opening_snapshots`)).rejects.toMatchObject({ code: "55000" });
  });

  it("holds real admission against inventory, receipt/attempt and build-demand writers until the opening snapshot is recorded", async () => {
    const input = await request(); const raw = new PostgresInventoryCutoverReconstructionRepository();
    const capture = vi.fn(async (client: PoolClient) => {
      const evidence = await raw.capture(client);
      await expect(pool.query("UPDATE inventory.inventory_levels SET reserved_qty=reserved_qty WHERE id=10")).rejects.toMatchObject({ code: "55P03" });
      await expectSupplementalCensusWritersBlocked();
      // The owning transaction can acquire its own statement pins without
      // changing any historical receipt or its immutable attempts.
      await client.query("DELETE FROM oms.channel_fulfillment_receipts WHERE false");
      await client.query("DELETE FROM oms.channel_fulfillment_receipt_attempts WHERE false");
      await client.query("DELETE FROM wms.order_build_demands WHERE false");
      return evidence;
    });
    const guarded = new InventoryCutoverOpeningService(new PostgresInventoryCutoverOpeningRepository(pool, { capture }), { now: () => NOW });
    await expect(guarded.save(input, "operator")).resolves.toMatchObject({ alreadyApplied: false });
    expect(capture).toHaveBeenCalledOnce();
  });

  it("rolls back the audit insert on a later failure and leaves the caller pool healthy", async () => {
    const input = await request(); const before = await immutableBusinessState();
    const client = await pool.connect(); const original = client.query.bind(client);
    const trace = vi.spyOn(client, "query").mockImplementation((async (...args: unknown[]) => {
      const result = await (original as (...args: unknown[]) => Promise<unknown>)(...args);
      if (String(args[0]).includes("INSERT INTO inventory.availability_cutover_opening_snapshots")) throw new Error("injected post-insert failure");
      return result;
    }) as typeof client.query);
    try {
      const isolated = new InventoryCutoverOpeningService(new PostgresInventoryCutoverOpeningRepository({ connect: async () => client } as Pick<Pool,"connect">), { now: () => NOW });
      await expect(isolated.save(input, "operator")).rejects.toThrow("injected post-insert failure");
      expect(trace.mock.calls.map(([sql]) => sql).at(-1)).toBe("ROLLBACK");
    } finally { trace.mockRestore(); }
    expect(await immutableBusinessState()).toEqual(before);
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.availability_cutover_opening_snapshots")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT 1 AS healthy")).rows[0].healthy).toBe(1);
  });
});
