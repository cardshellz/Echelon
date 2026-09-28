import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import type { InventoryActivationDryRun } from "@shared/types/inventory-availability-phase4";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import {
  cutoverCompositionBaseSql,
  seedCompositionReviewedDryRun,
} from "../fixtures/inventory-cutover-composition-database.fixture";
import { installWalmartPublicationInventoryFixture } from "../fixtures/walmart-publication-inventory.fixture";
import { PostgresInventoryChannelExposureAdminStore } from "../../infrastructure/inventory-channel-exposure-admin.repository";
import { PostgresInventoryAvailabilityShadowRepository } from "../../infrastructure/inventory-availability-shadow.repository";
import { InventoryAvailabilityShadowService } from "../../application/inventory-availability-shadow.service";
import { assertDryRunSelectionsCurrent } from "../../infrastructure/inventory-availability-activation.repository";

// Only the process-global connection is replaced; every exercised owner uses a
// separately created disposable database with the actual membership triggers.
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = databaseUrl && disposable ? describe : describe.skip;

dbDescribe.sequential("publication scope in preview and sealed cutover evidence", () => {
  let database: InventoryCutoverTestDatabase;
  let preview: PostgresInventoryChannelExposureAdminStore;
  let shadows: PostgresInventoryAvailabilityShadowRepository;

  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, cutoverCompositionBaseSql);
    await installWalmartPublicationInventoryFixture(database.pool, { targetState: "preview" });
    shadows = new PostgresInventoryAvailabilityShadowRepository(database.pool);
    preview = new PostgresInventoryChannelExposureAdminStore(drizzle(database.pool, { schema }), shadows);
    await new InventoryAvailabilityShadowService(shadows).runProductShadow(
      20, { idempotencyKey: "scope-test-shadow" }, "scope-test-operator",
    );
  }, 30_000);

  afterEach(async () => { await database?.close(); });

  async function setMembership(variantId: number, included = true): Promise<void> {
    // Synthetic reviewed facts only. This helper is not a production apply API.
    await database.pool.query(`WITH version AS (
      INSERT INTO inventory.publication_membership_versions
        (publication_target_id,product_variant_id,version,included,definition_hash,review_hash,created_by,created_at)
      SELECT 2,$1,COALESCE(MAX(version),0)+1,$2,repeat('a',64),repeat('b',64),'scope-test-operator',transaction_timestamp()
      FROM inventory.publication_membership_versions WHERE publication_target_id=2 AND product_variant_id=$1
      RETURNING id
    ) INSERT INTO inventory.publication_membership_heads(publication_target_id,product_variant_id,active_version_id)
      SELECT 2,$1,id FROM version ON CONFLICT(publication_target_id,product_variant_id)
      DO UPDATE SET active_version_id=EXCLUDED.active_version_id`, [variantId, included]);
  }

  async function reviewedRun(includedVariantIds: number[]): Promise<InventoryActivationDryRun> {
    const run = await seedCompositionReviewedDryRun(database.pool);
    run.products[0]!.publicationTargetSelections = [{
      publicationTargetId: 2, revision: "2", membership: { mode: "explicit", includedVariantIds },
    }];
    return run;
  }

  async function verifySelections(run: InventoryActivationDryRun): Promise<void> {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await assertDryRunSelectionsCurrent(client, run, false);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  it("does not expand an empty explicit destination to the whole product", async () => {
    const result = await preview.preview(2, 20);
    expect(result.membership).toEqual({ mode: "explicit", includedVariantIds: [] });
    expect(result.rows).toEqual([]);
    expect(result.blockers).toEqual([]);
    const wholeProduct = await preview.preview(1, 20);
    expect(wholeProduct.membership).toEqual({ mode: "whole_product" });
    expect(wholeProduct.rows.map(row => row.productVariantId)).toEqual([101, 102, 103, 104, 105]);
    expect(result).toMatchObject({ runtimeAuthorityChanged: false, providerWriteAttempted: false, outboxEnqueued: false });
    expect((await database.pool.query("SELECT authority FROM inventory.availability_runtime_authority")).rows)
      .toEqual([{ authority: "legacy" }]);
    expect((await database.pool.query("SELECT id FROM inventory.inventory_publication_outbox")).rows).toEqual([]);
  });

  it("selects one outbound SKU without trimming the captured ATP supply snapshot", async () => {
    await setMembership(101);
    const result = await preview.preview(2, 20);
    expect(result.membership).toEqual({ mode: "explicit", includedVariantIds: [101] });
    expect(result.rows.map(row => row.productVariantId)).toEqual([101]);
    expect(result.blockers).toEqual([]);
    const shadow = await shadows.getLatestShadowRun(20);
    expect([...new Set(shadow!.results.map(row => row.productVariantId))]).toEqual([101, 102, 103, 104, 105]);
  });

  it("still blocks an included SKU without an exact provider mapping", async () => {
    await setMembership(102);
    const result = await preview.preview(2, 20);
    expect(result.rows.map(row => row.productVariantId)).toEqual([102]);
    expect(result.blockers.map(row => row.code)).toContain("PUBLICATION_TARGET_VARIANT_MAPPING_MISSING");
  });
  it("carries the exact excluded identities without producing publication rows", async () => {
    await setMembership(102, false);
    const result = await preview.preview(2, 20);
    expect(result.membership).toEqual({ mode: "explicit", includedVariantIds: [], excludedVariantIds: [102] });
    expect(result.rows).toEqual([]);
    expect(result.blockers).toEqual([]);
    const run = await reviewedRun([]);
    run.products[0]!.publicationTargetSelections![0]!.membership = result.membership!;
    await expect(verifySelections(run)).resolves.toBeUndefined();
    await setMembership(103, false);
    await expect(verifySelections(run)).rejects.toMatchObject({ code: "ACTIVATION_PUBLICATION_MEMBERSHIP_CHANGED" });
  });
  it.each(["external_provider", "manual"])("does not require Echelon publishing setup for a %s destination", async authority => {
    await database.pool.query("INSERT INTO channels.channel_connections(id,channel_id) VALUES(80,36)");
    await database.pool.query(`INSERT INTO inventory.inventory_publication_targets(channel_id,channel_connection_id,fulfillment_node_id,provider_scope_type,
        external_scope_id,publication_authority,state,change_reason,created_by)
      VALUES(36,80,1,'location','external-scope',$1,'disabled','External test destination','operator')`, [authority]);
    await database.pool.query("UPDATE inventory.inventory_publication_targets SET state='preview',revision=revision+1,activated_by='operator',activated_at=transaction_timestamp() WHERE id=3");
    const result = await preview.preview(3, 20);
    expect(result).toMatchObject({ publicationAuthority: authority, rows: [], selectedPolicies: [], blockers: [],
      sourceBindingId: null, sourceBindingAuthority: "missing", runtimeAuthorityChanged: false,
      providerWriteAttempted: false, outboxEnqueued: false });
  });

  it("does not silently drop an included SKU that becomes inactive", async () => {
    await setMembership(105);
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=105");
    const result = await preview.preview(2, 20);
    expect(result.membership).toEqual({ mode: "explicit", includedVariantIds: [105] });
    expect(result.rows).toEqual([]);
    expect(result.blockers.map(row => row.code)).toContain("PUBLICATION_MEMBER_VARIANT_UNAVAILABLE");
  });

  it("revalidates a deliberately empty preview destination without requiring publication rows", async () => {
    await expect(verifySelections(await reviewedRun([]))).resolves.toBeUndefined();
  });

  it("rejects a changed target revision even when both old and new scopes are empty", async () => {
    const run = await reviewedRun([]);
    await database.pool.query("UPDATE inventory.inventory_publication_targets SET revision=revision+1 WHERE id=2");
    await expect(verifySelections(run)).rejects.toMatchObject({ code: "ACTIVATION_PUBLICATION_MEMBERSHIP_CHANGED" });
  });

  it("rejects a membership-head change even without a target revision change", async () => {
    const run = await reviewedRun([]);
    await setMembership(101);
    await expect(verifySelections(run)).rejects.toMatchObject({ code: "ACTIVATION_PUBLICATION_MEMBERSHIP_CHANGED" });
  });

  it("rejects exclusion of a reviewed member and keeps its immutable evidence", async () => {
    await setMembership(101);
    const run = await reviewedRun([101]);
    await expect(verifySelections(run)).resolves.toBeUndefined();
    await setMembership(101, false);
    await expect(verifySelections(run)).rejects.toMatchObject({ code: "ACTIVATION_PUBLICATION_MEMBERSHIP_CHANGED" });
    expect((await database.pool.query("SELECT included FROM inventory.publication_membership_versions ORDER BY id")).rows)
      .toEqual([{ included: true }, { included: false }]);
  });

  it("does not allow an empty Echelon destination to skip the preview-only activation gate", async () => {
    const run = await reviewedRun([]);
    await database.pool.query("UPDATE inventory.inventory_publication_targets SET state='live',revision=revision+1 WHERE id=2");
    run.products[0]!.publicationTargetSelections![0]!.revision = "3";
    await expect(verifySelections(run)).rejects.toMatchObject({ code: "ACTIVATION_PUBLICATION_MEMBERSHIP_CHANGED" });
  });
});
