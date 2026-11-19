import type { Pool, PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../fixtures/inventory-cutover-composition-database.fixture";
import { WALMART_INVENTORY_NOW } from "../fixtures/walmart-publication-inventory.fixture";
import {
  DROPSHIP_EBAY_STOCK as F, addDropshipLivePush, createDropshipEbayTarget, installDropshipEbayStockFixture, sealDropshipMapping,
} from "../fixtures/dropship-ebay-stock.fixture";
import {
  PublicationMappingPreparationStore, applyMappingPreparation, readTargets, reviewMappingPreparation,
} from "../../infrastructure/publication-mapping-preparation.repository";
import { loadPublicationTargetScopes, PUBLICATION_TARGET_SCOPE_LOCK_SEED } from "../../infrastructure/inventory-publication-target-stop.repository";
import { quantityPublicationScopeLockKey } from "../../infrastructure/quantity-publication-admission.repository";
import { acquireInventoryCutoverFenceInsideTransaction } from "../../infrastructure/inventory-cutover-admission-fence.repository";
import type { QuantityPublicationScope } from "../../domain/quantity-publication-admission";

// P1 (PLAN-F2-v2 section 9.2): readTargets resolves a Dropship destination's
// transport provider from its store platform, not its policy channel, and its
// provider scope locks equal the ones the Dropship eBay admission holds.
const runtime = vi.hoisted(() => ({ pool: null as Pool | null }));
vi.mock("../../../../db", () => ({ pool: new Proxy({} as Pool, { get(_target, key) {
  if (!runtime.pool) throw new Error("Disposable database is not initialized.");
  const value = Reflect.get(runtime.pool, key);
  return typeof value === "function" ? value.bind(runtime.pool) : value;
} }), db: {} }));

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = url && disposable ? describe : describe.skip;

/** The Dropship eBay admission's exact scope (quantity-publication-runtime.ts createDropshipEbayQuantityRequestAdmission). */
const admissionScope = (sku: string): QuantityPublicationScope => ({ destinationKind: "dropship_store_connection",
  connectionId: F.storeConnectionId, providerKey: "ebay", providerScopeType: "account", externalScopeId: F.accountId,
  externalInventoryItemId: sku, productId: null, productVariantId: null });

/** Byte-for-byte the readTargets SQL before this change, kept to prove channel targets are unchanged. */
const PREVIOUS_READ_TARGETS_SQL = `SELECT t.id,t.channel_id,t.channel_connection_id,t.dropship_store_connection_id,t.destination_kind,
    c.provider AS provider_key,t.provider_scope_type,t.external_scope_id,t.revision::text,t.state,t.publication_authority,t.hold_reason,t.held_at,
    (EXISTS(SELECT 1 FROM inventory.publication_source_binding_heads h JOIN inventory.publication_source_binding_versions b
      ON b.id=h.active_binding_id AND b.lifecycle_status='sealed' JOIN inventory.publication_source_binding_members m ON m.binding_id=b.id WHERE h.publication_target_id=t.id)
    AND NOT EXISTS(SELECT 1 FROM inventory.publication_source_binding_heads h JOIN inventory.publication_source_binding_versions b ON b.id=h.active_binding_id
      JOIN inventory.publication_source_binding_members m ON m.binding_id=b.id LEFT JOIN warehouse.fulfillment_nodes n ON n.id=m.fulfillment_node_id
      WHERE h.publication_target_id=t.id AND(n.id IS NULL OR n.lifecycle_status<>'active' OR(c.provider='walmart' AND n.warehouse_id IS DISTINCT FROM w.warehouse_id)))
    AND c.status='active' AND(c.provider<>'walmart' OR(w.connection_id=t.channel_connection_id AND w.ship_node_id=t.external_scope_id AND t.provider_scope_type='location'))) IS TRUE AS source_ready
    FROM inventory.inventory_publication_targets t JOIN channels.channels c ON c.id=t.channel_id
    LEFT JOIN channels.walmart_connections w ON w.channel_id=t.channel_id
    WHERE($1::integer IS NULL OR t.channel_id=$1) AND($2::integer IS NULL OR t.channel_connection_id=$2) AND($3::integer IS NULL OR t.id=$3)
    ORDER BY t.id`;

dbDescribe.sequential("mapping preparation targets for Dropship store destinations, real PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  const withClient = async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => {
    const client = await database.pool.connect();
    try { return await work(client); } finally { client.release(); }
  };
  // Variant 101 is a retained Dropship listing (provider identity saved), so
  // the Dropship selection owner says publish; the planner then needs only its mapping.
  const retainedListing = () => addDropshipLivePush(database.pool, { listingId: 1, productVariantId: F.variantId, sku: F.sku,
    jobId: 1, jobItemId: 1, status: "completed", externalListingId: "listing-P5", externalOfferId: "offer-P5", listingStatus: "active" });

  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    runtime.pool = database.pool;
    await installDropshipEbayStockFixture(database.pool);
  }, 60_000);
  afterEach(async () => { await database?.close(); runtime.pool = null; });

  it("resolves a Dropship destination on the internal 'manual' policy channel to its eBay store platform", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    const [target] = await withClient(client => readTargets(client, undefined, undefined, targetId));
    expect(target).toMatchObject({ id: targetId, channel_id: F.policyChannelId, destination_kind: "dropship_store_connection",
      dropship_store_connection_id: F.storeConnectionId, provider_key: "ebay", provider_scope_type: "account",
      external_scope_id: F.accountId, state: "live", publication_authority: "echelon", source_ready: true });
  });

  it("locks exactly the provider scopes the Dropship eBay admission holds", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await sealDropshipMapping(database.pool, targetId, F.variantId, F.sku);
    const keys = await withClient(async client => {
      const [target] = await readTargets(client, undefined, undefined, targetId);
      return (await loadPublicationTargetScopes(client, target!, F.productId)).map(quantityPublicationScopeLockKey);
    });
    expect(keys).toEqual([quantityPublicationScopeLockKey(admissionScope(F.sku))]);
  });

  it("refuses preparation while the Dropship admission holds the exact scope, even on a Shopify policy channel", async () => {
    // The shared seed leaves the Shopify policy channel in setup; source readiness needs it active.
    await database.pool.query("UPDATE channels.channels SET status='active' WHERE id=35");
    const targetId = await createDropshipEbayTarget(database.pool, { channelId: 35 });
    await sealDropshipMapping(database.pool, targetId, F.variantId, F.sku);
    await retainedListing();
    const holder = await database.pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtextextended($1,$2))",
        [quantityPublicationScopeLockKey(admissionScope(F.sku)), PUBLICATION_TARGET_SCOPE_LOCK_SEED]);
      const store = new PublicationMappingPreparationStore(database.pool);
      await expect(store.transaction("configuration", async (client, scopeKeys) => {
        // Every real caller takes the inventory fence first (ebay-publication-readiness.repository.ts).
        await acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority: "canonical", expectedConfigurationRunId: null });
        const [target] = await readTargets(client, undefined, undefined, targetId);
        const command = { publicationTargetId: targetId, expectedTargetRevision: target!.revision, productId: F.productId,
          productVariantIds: [F.variantId] };
        const reviewed = (await reviewMappingPreparation(client, command, true)).review;
        expect(reviewed).toMatchObject({ ready: true, blockers: [] });
        return applyMappingPreparation(client, scopeKeys, { ...command, expectedReviewHash: reviewed.reviewHash,
          idempotencyKey: "p1-provider-busy" }, "p1-test", "a".repeat(64), WALMART_INVENTORY_NOW, []);
      })).rejects.toMatchObject({ code: "STOCK_MAPPING_PROVIDER_BUSY" });
    } finally {
      await holder.query("SELECT pg_advisory_unlock_all()");
      holder.release();
    }
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.publication_mapping_preparations")).rows[0].n).toBe(0);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.inventory_publication_outbox WHERE publication_target_id=$1", [targetId])).rows[0].n).toBe(0);
  });

  it("keeps a Dropship destination's source ready when its policy channel is a Walmart channel", async () => {
    const targetId = await createDropshipEbayTarget(database.pool, { channelId: 36 });
    const [target] = await withClient(client => readTargets(client, undefined, undefined, targetId));
    expect(target).toMatchObject({ provider_key: "ebay", source_ready: true });
  });

  it("filters destinations by exact Dropship store connection", async () => {
    const own = await createDropshipEbayTarget(database.pool);
    const other = await createDropshipEbayTarget(database.pool, { storeConnectionId: 23, accountId: "other-seller" });
    const rows = await withClient(client => readTargets(client, undefined, undefined, undefined, false, F.storeConnectionId));
    expect(rows.map(row => row.id)).toEqual([own]);
    expect((await withClient(client => readTargets(client, undefined, undefined, undefined, false, 23))).map(row => row.id)).toEqual([other]);
    expect((await withClient(client => readTargets(client, undefined, undefined, undefined, false, 999))).map(row => row.id)).toEqual([]);
  });

  it("returns the same rows as the previous SQL for every channel destination and filter", async () => {
    await createDropshipEbayTarget(database.pool);
    await database.pool.query("UPDATE inventory.inventory_publication_targets SET held_at=transaction_timestamp(),hold_reason='Fixture hold',held_by='fixture',revision=revision+1 WHERE id=1");
    const channelTargets = (await database.pool.query<{ id: number; channel_id: number; channel_connection_id: number }>(
      "SELECT id,channel_id,channel_connection_id FROM inventory.inventory_publication_targets WHERE destination_kind='channel_connection' ORDER BY id")).rows;
    expect(channelTargets.length).toBeGreaterThanOrEqual(3);
    const filters: Array<[number | undefined, number | undefined, number | undefined]> = [[undefined, undefined, undefined],
      ...channelTargets.flatMap(row => [[row.channel_id, undefined, undefined], [undefined, row.channel_connection_id, undefined],
        [undefined, undefined, row.id], [row.channel_id, row.channel_connection_id, row.id]] as Array<[number | undefined, number | undefined, number | undefined]>)];
    for (const [channelId, connectionId, targetId] of filters) {
      const previous = (await database.pool.query(PREVIOUS_READ_TARGETS_SQL, [channelId ?? null, connectionId ?? null, targetId ?? null])).rows
        .filter(row => row.destination_kind === "channel_connection");
      const current = (await withClient(client => readTargets(client, channelId, connectionId, targetId)))
        .filter(row => row.destination_kind === "channel_connection");
      expect(current).toEqual(previous);
    }
    // The Walmart destination keeps its warehouse-matched source proof.
    expect((await withClient(client => readTargets(client, undefined, undefined, 2)))[0]).toMatchObject({ provider_key: "walmart" });
  });
});
