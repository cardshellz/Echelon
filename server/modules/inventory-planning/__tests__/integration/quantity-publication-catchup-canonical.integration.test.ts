import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql, cutoverCompositionSeedSql, cutoverCompositionChannelSeedSql,
  installCutoverCompositionMigrations, seedCompositionReviewedDryRun } from "../fixtures/inventory-cutover-composition-database.fixture";
import { PostgresQuantityPublicationAdmission } from "../../infrastructure/quantity-publication-admission.repository";
import type { QuantityPublicationScope } from "../../domain/quantity-publication-admission";

vi.mock("../../../../db", () => ({ pool: {} }));
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = databaseUrl && disposable ? describe : describe.skip;

dbDescribe.sequential("canonical catch-up completion uses exact current outbox lineage", () => {
  let database: InventoryCutoverTestDatabase;
  let admission: PostgresQuantityPublicationAdmission;
  let runId: string;
  let sequence = 0;
  const clock = () => new Date("2026-09-08T15:00:00.000Z");
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, cutoverCompositionBaseSql);
    await installCutoverCompositionMigrations(database.pool);
    await database.pool.query(cutoverCompositionSeedSql);
    await database.pool.query(cutoverCompositionChannelSeedSql);
    const dryRun = await seedCompositionReviewedDryRun(database.pool);
    // Valid constrained fixture state, not a claim that this suite exercises
    // the separate administrator cutover workflow. All real triggers remain on.
    runId = (await database.pool.query<{ id: string }>(`INSERT INTO inventory.availability_activation_runs
      (mode,state,request_hash,expected_catalog_input_hash,expected_catalog_result_hash,
       captured_catalog_input_hash,captured_catalog_result_hash,evidence_payload,idempotency_key,reason,
       requested_by,started_at,source_dry_run_id)
      SELECT 'activation','activating',request_hash,expected_catalog_input_hash,expected_catalog_result_hash,
        captured_catalog_input_hash,captured_catalog_result_hash,evidence_payload,'catchup-canonical-fixture',
        'Test current canonical proof','operator',started_at,id FROM inventory.availability_activation_runs WHERE id=$1
      RETURNING id::text`, [dryRun.activationRunId])).rows[0].id;
    await database.pool.query(`UPDATE inventory.availability_runtime_authority SET authority='canonical',activation_run_id=$1,
      revision=revision+1,changed_by='operator',change_reason='Test canonical proof' WHERE singleton_key=true`, [runId]);
    await database.pool.query(`UPDATE inventory.availability_activation_runs SET state='active',runtime_authority_changed=true WHERE id=$1`, [runId]);
    admission = new PostgresQuantityPublicationAdmission(database.pool, clock);
  }, 30000);
  afterAll(async () => { await database?.close(); });

  async function scope(): Promise<QuantityPublicationScope> {
    const productVariantId = 200 + ++sequence;
    const externalInventoryItemId = `CANONICAL-${sequence}`;
    await database.pool.query("INSERT INTO catalog.product_variants(id,product_id,sku) VALUES($1,20,$2)", [productVariantId, externalInventoryItemId]);
    return { destinationKind: "channel_connection", connectionId: 7, providerKey: "shopify", providerScopeType: "location",
      externalScopeId: "test-location", externalInventoryItemId, productId: 20, productVariantId };
  }
  async function outbox(target: QuantityPublicationScope, desiredRevision = 1): Promise<{ outboxId: string; quantity: number }> {
    const quantity = 15 - desiredRevision;
    const row = (await database.pool.query<{ id: string }>(`INSERT INTO inventory.inventory_publication_outbox
      (activation_run_id,publication_target_id,product_variant_id,desired_revision,desired_quantity,channel_connection_id_snapshot,
       external_scope_id_snapshot,external_inventory_item_id_snapshot,state,idempotency_key,payload_hash,available_at,
       publication_phase,channel_id_snapshot,provider_key_snapshot,provider_scope_type_snapshot,publication_target_revision_snapshot)
      VALUES($1,1,$2,$3,$4,7,'test-location',$5,'queued',$6,repeat('a',64),$7,'full',36,'shopify','location',2) RETURNING id::text`,
    [runId,target.productVariantId,desiredRevision,quantity,target.externalInventoryItemId,
      `canonical-proof:${target.productVariantId}:${desiredRevision}`,clock()])).rows[0];
    return { outboxId: row.id, quantity };
  }
  async function pending(target: QuantityPublicationScope) {
    const callback = vi.fn();
    await expect(admission.run(target, callback)).rejects.toMatchObject({ code: "PUBLICATION_CANONICAL_OWNER_REQUIRED" });
    expect(callback).not.toHaveBeenCalled();
    return (await admission.listDue(100)).find(claim => claim.scope.externalInventoryItemId === target.externalInventoryItemId)!;
  }

  it("completes a current exact canonical listing success without replanning", async () => {
    const target = await scope(); const plan = await outbox(target); const claim = await pending(target);
    await admission.runListing(target, async () => plan, async quantity => ({ publishedQuantity: quantity }));
    expect(await admission.complete(claim)).toBe(true);
  });
  it("does not reuse a superseded successful plan but accepts a fresh exact queued outbox handoff", async () => {
    const target = await scope(); const oldPlan = await outbox(target); const claim = await pending(target);
    await admission.runListing(target, async () => oldPlan, async quantity => ({ publishedQuantity: quantity }));
    const currentPlan = await outbox(target, 2);
    expect(await admission.complete(claim)).toBe(false);
    expect(await admission.complete(claim, oldPlan)).toBe(false);
    expect(await admission.complete(claim, currentPlan)).toBe(true);
  });
  it("rejects another scope's current canonical outbox", async () => {
    const target = await scope(); const other = await scope(); const claim = await pending(target);
    const unrelatedPlan = await outbox(other);
    expect(await admission.complete(claim, unrelatedPlan)).toBe(false);
    expect(await admission.complete(claim, await outbox(target))).toBe(true);
  });
  it("does not mistake unplanned reducing lifecycle success for canonical delivery", async () => {
    const target = await scope(); const claim = await pending(target);
    await admission.runQuantityReducingLifecycle(target, async () => ({ withdrawn: true }));
    expect(await admission.complete(claim)).toBe(false);
    expect(await admission.complete(claim, await outbox(target))).toBe(true);
  });
  it("blocks even a current canonical handoff while a newer attempt remains uncertain", async () => {
    const target = await scope(); const plan = await outbox(target); await pending(target);
    await expect(admission.runListing(target, async () => plan, async () => { throw new Error("Provider outcome unknown"); })).rejects.toThrow();
    const claim = (await admission.listDue(100)).find(row => row.scope.externalInventoryItemId === target.externalInventoryItemId)!;
    expect(await admission.complete(claim, plan)).toBe(false);
  });
});
