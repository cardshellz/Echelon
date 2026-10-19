import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../fixtures/inventory-cutover-composition-database.fixture";
import { installEbayPublicationInventoryFixture } from "../fixtures/ebay-publication-inventory.fixture";
import { ensureEbayPublicationReady } from "../../infrastructure/ebay-publication-readiness.repository";
import {
  createAuthorityAwareInventoryPublicationService,
  createInventoryChannelQuantityRuntimeService,
  PostgresInventoryAvailabilityRuntimePublicationExecutor,
} from "../../infrastructure/inventory-availability-runtime-publication.repository";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = url && disposable ? describe : describe.skip;
const NOW = new Date("2026-10-12T12:00:00.000Z");
const logger = { info: () => {}, warn: () => {} };
const request = {
  productId: 20,
  channelId: 67,
  target: { destinationKind: "channel_connection" as const, connectionId: 9, providerKey: "ebay", providerScopeType: "account" as const, externalScopeId: "seller-36" },
  triggeredBy: "listing_feed_read_regression",
};

dbDescribe.sequential("channel quantity reads do not construct publication cleanup", () => {
  let database: InventoryCutoverTestDatabase;
  const legacy = vi.fn(async () => { throw new Error("Canonical reads must not fall back to legacy quantities."); });

  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    await installEbayPublicationInventoryFixture(database.pool);
    // Only P5 is an active sellable variant in this incident-shaped fixture.
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id<>101");
    legacy.mockClear();
  }, 60_000);
  afterEach(async () => { await database?.close(); });

  const reader = () => createInventoryChannelQuantityRuntimeService(database.pool, logger);
  const publisher = () => createAuthorityAwareInventoryPublicationService(database.pool, { channelId: 67, logger });
  const read = () => reader().readProduct(request, legacy);

  async function prepareHealthyMapping(): Promise<void> {
    await ensureEbayPublicationReady(database.pool, {
      channelId: 67, connectionId: 9, accountId: "seller-36", environment: "production", productId: 20,
      variants: [{ productVariantId: 101, sku: "P5" }],
    }, { commandKey: "00000000-0000-4000-8000-000000000099", actor: "test", now: NOW });
  }

  async function retainUnmappedSibling(): Promise<void> {
    await database.pool.query(`INSERT INTO channels.channel_listings
      (id,channel_id,product_variant_id,external_sku,external_variant_id,external_product_id,sync_status)
      VALUES(2,67,102,'NEW','retained-offer','retained-listing','synced')`);
    expect((await database.pool.query(`SELECT active_mapping_id FROM inventory.publication_variant_mapping_heads
      WHERE publication_target_id=3 AND product_variant_id=102`)).rows).toEqual([]);
  }

  /** Snapshot every application table, including quantity journals, mapping
   * versions, receipts and audit evidence. PostgreSQL catalog/sequence internals
   * are excluded; reads must not mutate any application row. */
  async function savedRows(): Promise<Record<string, unknown>> {
    const tables = (await database.pool.query<{ schemaname: string; tablename: string }>(`SELECT schemaname,tablename FROM pg_tables
      WHERE schemaname IN ('inventory','catalog','channels','warehouse','wms','oms','dropship','ebay')
        OR (schemaname='public' AND tablename IN ('audit_events','idempotency_keys'))
      ORDER BY schemaname,tablename`)).rows;
    const snapshot: Record<string, unknown> = {};
    for (const table of tables) {
      const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
      const qualified = `${quote(table.schemaname)}.${quote(table.tablename)}`;
      snapshot[qualified] = (await database.pool.query(`SELECT to_jsonb(saved) AS row FROM ${qualified} saved
        ORDER BY to_jsonb(saved)::text`)).rows.map(row => row.row);
    }
    return snapshot;
  }

  it("reads the healthy SKU despite an archived retained sibling lacking a clearing mapping, without any writes", async () => {
    await prepareHealthyMapping();
    await retainUnmappedSibling();
    const before = await savedRows();
    const expected = { authority: "canonical", productId: 20,
      rows: [{ productVariantId: 101, quantity: 17, publicationTargetIds: [3] }] };
    // Real physical-only ATP: 20 on hand less 3 reserved in the exact source.
    expect(await read()).toEqual(expected);
    expect(await Promise.all([read(), read()])).toEqual([expected, expected]);
    expect(legacy).not.toHaveBeenCalled();
    expect(await savedRows()).toEqual(before);
  });

  it.each([true, false])("publishes only the active sibling without inventing a stock-clearing duty for a Catalog archive (dryRun=%s)", async dryRun => {
    await prepareHealthyMapping();
    await retainUnmappedSibling();
    const listingBefore = (await database.pool.query("SELECT * FROM channels.channel_listings WHERE id=2")).rows;
    await expect(publisher().publishProduct({ productId: 20, dryRun, triggeredBy: "actual_publication" }, legacy))
      .resolves.toMatchObject({ authority: "canonical", publication: { dryRun,
        rows: [{ productVariantId: 101, publicationTargetId: 3, desiredQuantity: "17" }] } });
    expect(legacy).not.toHaveBeenCalled();
    expect((await database.pool.query("SELECT * FROM channels.channel_listings WHERE id=2")).rows).toEqual(listingBefore);
    expect((await database.pool.query(`SELECT active_mapping_id FROM inventory.publication_variant_mapping_heads
      WHERE publication_target_id=3 AND product_variant_id=102`)).rows).toEqual([]);
    expect((await database.pool.query(`SELECT id FROM inventory.inventory_publication_outbox
      WHERE publication_target_id=3 AND product_variant_id=102`)).rows).toEqual([]);
  });

  it.each([true, false])("keeps the missing clearing-identity guard when only the channel selection is disabled (dryRun=%s), with no partial writes", async dryRun => {
    await prepareHealthyMapping();
    await retainUnmappedSibling();
    // Catalog archival belongs to the listing lifecycle. An active Catalog SKU
    // excluded only from this channel still requires an exact stock-clearing mapping.
    await database.pool.query("UPDATE catalog.product_variants SET is_active=true,ebay_listing_excluded=true WHERE id=102");
    const before = await savedRows();
    const executor = new PostgresInventoryAvailabilityRuntimePublicationExecutor(database.pool, logger);
    const plan = await executor.execute(context => context.planProduct(20, 67, "publication"));
    expect(plan.targets.find(target => target.publicationTargetId === 3)?.rows.find(row => row.productVariantId === 102))
      .toMatchObject({ publishedUnits: "0", mapping: null,
        blockers: [{ code: "PUBLICATION_TARGET_VARIANT_MAPPING_MISSING" }] });
    await expect(publisher().publishProduct({ productId: 20, dryRun, triggeredBy: "actual_publication" }, legacy))
      .rejects.toMatchObject({ code: "CANONICAL_PUBLICATION_MAPPING_MISSING",
        context: { productId: 20, publicationTargetId: 3, blockerCodes: ["PUBLICATION_TARGET_VARIANT_MAPPING_MISSING"] } });
    expect(legacy).not.toHaveBeenCalled();
    expect(await savedRows()).toEqual(before);
  });

  it("calculates selected stock before its provider mapping exists while keeping the read plan non-publishable", async () => {
    const before = await savedRows();
    expect(await read()).toEqual({ authority: "canonical", productId: 20,
      rows: [{ productVariantId: 101, quantity: 17, publicationTargetIds: [3] }] });
    const executor = new PostgresInventoryAvailabilityRuntimePublicationExecutor(database.pool, logger);
    const plan = await executor.execute(context => context.planProduct(20, 67, "channel_quantity_read"));
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]).toMatchObject({ publicationTargetId: 3, readOnly: true, publishable: false,
      rows: [{ productVariantId: 101, canonicalAtpUnits: "17", publishedUnits: "17", mapping: null, blockers: [] }] });
    await expect(publisher().publishProduct({ productId: 20, dryRun: false }, legacy))
      .rejects.toMatchObject({ code: "CANONICAL_PUBLICATION_MAPPING_MISSING" });
    expect(await savedRows()).toEqual(before);
  });

  it.each(["destination", "variant"])("honors an existing %s hold without requiring a provider mapping", async kind => {
    if (kind === "destination") {
      await database.pool.query(`UPDATE inventory.inventory_publication_targets
        SET held_at=$1,held_by='operator',hold_reason='Reviewed stop',revision=revision+1 WHERE id=3`, [NOW]);
    } else {
      await database.pool.query(`INSERT INTO inventory.inventory_publication_target_variant_holds
        (publication_target_id,product_variant_id,hold_reason,held_at,held_by) VALUES(3,101,'Reviewed SKU stop',$1,'operator')`, [NOW]);
    }
    const before = await savedRows();
    expect(await read()).toEqual({ authority: "canonical", productId: 20,
      rows: [{ productVariantId: 101, quantity: 0, publicationTargetIds: [3] }] });
    expect(await savedRows()).toEqual(before);
  });

  it("does not substitute product-wide stock for a missing active source binding", async () => {
    await database.pool.query(`UPDATE inventory.publication_source_binding_heads
      SET active_binding_id=NULL,revision=revision+1 WHERE publication_target_id=3`);
    const before = await savedRows();
    await expect(read()).rejects.toMatchObject({ code: "CANONICAL_CHANNEL_QUANTITY_BLOCKED",
      context: { publicationTargetId: 3, blockerCodes: expect.arrayContaining(["CHANNEL_SOURCE_BINDING_MISSING"]) } });
    expect(legacy).not.toHaveBeenCalled();
    expect(await savedRows()).toEqual(before);
  });

  it("does not hide ambiguous saved listing identities behind a quantity-only read", async () => {
    await database.pool.query(`INSERT INTO channels.channel_listings
      (id,channel_id,product_variant_id,external_sku,external_variant_id,sync_status)
      VALUES(2,67,101,'P5','conflicting-offer','synced')`);
    const before = await savedRows();
    await expect(read()).rejects.toMatchObject({ code: "CHANNEL_SELECTION_AMBIGUOUS" });
    expect(await savedRows()).toEqual(before);
  });

  it("does not invent an exposure policy when the active policy is missing", async () => {
    await database.pool.query(`UPDATE inventory.channel_exposure_policy_heads
      SET active_policy_id=NULL,revision=revision+1 WHERE scope_key='channel:67'`);
    const before = await savedRows();
    await expect(read()).rejects.toMatchObject({ code: "CANONICAL_CHANNEL_QUANTITY_BLOCKED",
      context: { publicationTargetId: 3, blockerCodes: expect.arrayContaining(["CHANNEL_EXPOSURE_POLICY_INCOMPLETE"]) } });
    expect(legacy).not.toHaveBeenCalled();
    expect(await savedRows()).toEqual(before);
  });

  it("uses only the target's bound warehouse stock", async () => {
    await database.pool.query(`INSERT INTO warehouse.warehouses(id,code) VALUES(2,'UNRELATED');
      INSERT INTO warehouse.warehouse_locations(id,warehouse_id) VALUES(200,2);
      INSERT INTO inventory.inventory_levels(id,warehouse_location_id,product_variant_id,variant_qty,reserved_qty,picked_qty,packed_qty)
        VALUES(20,200,101,100,0,0,0)`);
    const before = await savedRows();
    expect(await read()).toEqual({ authority: "canonical", productId: 20,
      rows: [{ productVariantId: 101, quantity: 17, publicationTargetIds: [3] }] });
    expect(await savedRows()).toEqual(before);
  });
});
