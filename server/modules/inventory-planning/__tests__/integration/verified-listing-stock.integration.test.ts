import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../fixtures/inventory-cutover-composition-database.fixture";
import { activateWalmartPublicationInventoryFixture, installWalmartPublicationInventoryFixture, WALMART_INVENTORY_NOW } from "../fixtures/walmart-publication-inventory.fixture";
import { VerifiedListingStockService } from "../../application/verified-listing-stock.service";
import { PostgresInventoryPublicationMembershipStore } from "../../infrastructure/inventory-publication-membership.repository";
import { PostgresInventoryPublicationSupplyReader } from "../../infrastructure/inventory-publication-supply-read.repository";
import { installCutoverAdmissionFixturePrerequisites } from "../fixtures/inventory-cutover-admission.fixture";
import { PostgresInventoryPublicationOutboxRepository } from "../../infrastructure/inventory-publication-outbox.repository";
import { PostgresQuantityPublicationAdmission } from "../../infrastructure/quantity-publication-admission.repository";
import { InventoryPublicationOutboxService } from "../../application/inventory-publication-outbox.service";
import { ChannelInventoryPublicationTransportAdapter } from "../../../channels/channel-inventory-publication-transport.adapter";
import { WalmartAdapter } from "../../../channels/adapters/walmart/walmart.adapter";
import { WalmartUsApi } from "../../../channels/adapters/walmart/walmart-us-api";
import { WalmartClient } from "../../../channels/adapters/walmart/walmart-client";
import type { WalmartChannelService } from "../../../channels/adapters/walmart/walmart-channel.service";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = url && disposable ? describe : describe.skip;

dbDescribe.sequential("verified Walmart listing joins canonical ATP", () => {
  let database: InventoryCutoverTestDatabase;
  let service: VerifiedListingStockService;
  const input = () => ({ channelId: 36, connectionId: 8, accountId: "partner-36", environment: "production",
    externalScopeId: "test-location", productVariantId: 101, sku: "P5", externalProductId: "WPID-P5",
    lifecycleStatus: "ACTIVE", publishedStatus: "PUBLISHED", observedAt: WALMART_INVENTORY_NOW.toISOString() });
  const counts = async () => (await database.pool.query(`SELECT
    (SELECT count(*)::int FROM inventory.publication_variant_mapping_heads WHERE publication_target_id=2) AS mappings,
    (SELECT count(*)::int FROM inventory.publication_membership_heads WHERE publication_target_id=2) AS members,
    (SELECT count(*)::int FROM inventory.inventory_publication_outbox WHERE publication_target_id=2) AS updates,
    (SELECT count(*)::int FROM inventory.publication_membership_applications WHERE publication_target_id=2) AS receipts`)).rows[0];
  const addWarehouseStock = async (hubWarehouseId: number | null, active = true) => {
    await database.pool.query("INSERT INTO warehouse.warehouses(id,code,hub_warehouse_id,is_active) VALUES(2,'SECONDARY',$1,$2)",
      [hubWarehouseId, active ? 1 : 0]);
    await database.pool.query(`INSERT INTO warehouse.warehouse_locations(id,warehouse_id) VALUES(200,2);
      INSERT INTO inventory.inventory_levels(id,warehouse_location_id,product_variant_id,variant_qty,reserved_qty,picked_qty,packed_qty)
        VALUES(20,200,101,5,0,0,0)`);
  };
  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    await installWalmartPublicationInventoryFixture(database.pool, { includeWalmartMapping: false });
    await activateWalmartPublicationInventoryFixture(database.pool);
    await database.pool.query(`ALTER TABLE channels.channel_feeds ADD COLUMN channel_product_id text;
      UPDATE channels.channel_feeds SET channel_product_id='WPID-P5' WHERE product_variant_id=101`);
    await installCutoverAdmissionFixturePrerequisites(database.pool);
    await database.pool.query(readFileSync(resolve("migrations/236_inventory_cutover_admission.sql"), "utf8"));
    await database.pool.query(readFileSync(resolve("migrations/0721_inventory_publication_direct_enable.sql"), "utf8"));
    service = new VerifiedListingStockService(new PostgresInventoryPublicationMembershipStore(database.pool), () => WALMART_INVENTORY_NOW);
  }, 30_000);
  afterEach(async () => { await database?.close(); });

  it("imports the verified mapping, enrolls the SKU and queues the exact canonical ATP quantity atomically", async () => {
    expect(await service.pending(36, 8, [101])).toEqual([101]);
    const result = await service.connect(input());
    expect(result).toMatchObject({ state: "connected", dryRun: false, receipt: { publicationTargetId: 2, publicationRows: 1 } });
    // Canonical ATP: 20 on-hand units less 3 reserved; picked units are tracked separately.
    expect(result.quantities).toEqual([{ productVariantId: 101, desiredQuantity: "17" }]);
    expect(await counts()).toEqual({ mappings: 1, members: 1, updates: 1, receipts: 1 });
    expect((await database.pool.query(`SELECT m.lifecycle_status,m.external_inventory_item_id,m.external_sku
      FROM inventory.publication_variant_mapping_heads h JOIN inventory.publication_variant_mapping_versions m ON m.id=h.active_mapping_id
      WHERE h.publication_target_id=2`)).rows).toEqual([{ lifecycle_status: "sealed", external_inventory_item_id: "P5", external_sku: "P5" }]);
    expect((await database.pool.query(`SELECT desired_quantity::text,external_inventory_item_id_snapshot FROM inventory.inventory_publication_outbox WHERE publication_target_id=2`)).rows)
      .toEqual([{ desired_quantity: "17", external_inventory_item_id_snapshot: "P5" }]);
    expect(await service.pending(36, 8, [101])).toEqual([]);
    expect(await service.connect(input())).toMatchObject({ state: "already_connected", receipt: null });
    expect(await counts()).toEqual({ mappings: 1, members: 1, updates: 1, receipts: 1 });
  });

  it("dry-runs the complete mapping, enrollment and queue transaction without persisting anything", async () => {
    expect(await service.connect(input(), { dryRun: true })).toMatchObject({ state: "connected", dryRun: true,
      quantities: [{ productVariantId: 101, desiredQuantity: "17" }] });
    expect(await counts()).toEqual({ mappings: 0, members: 0, updates: 0, receipts: 0 });
    expect((await database.pool.query("SELECT revision::text FROM inventory.inventory_publication_targets WHERE id=2")).rows[0].revision).toBe("3");
    expect((await database.pool.query("SELECT * FROM public.audit_events WHERE actor='walmart-stock-connection'")).rows).toEqual([]);
  });

  it.each([
    { source: "hub stock", reserve: false, reserveOnly: false, quantity: 17 },
    { source: "hub and linked reserve stock", reserve: true, reserveOnly: false, quantity: 22 },
    { source: "linked reserve stock only", reserve: true, reserveOnly: true, quantity: 5 },
  ])("enrolls and verifies $source through Walmart, retrying a stale first read", async ({ reserve, reserveOnly, quantity }) => {
    if (reserve) await addWarehouseStock(1);
    if (reserveOnly) {
      // All physical hub stock is already reserved; only its reserve can supply this SKU.
      await database.pool.query("UPDATE inventory.inventory_levels SET variant_qty=reserved_qty WHERE warehouse_location_id=100");
    }
    expect(await service.connect(input())).toMatchObject({ state: "connected",
      quantities: [{ productVariantId: 101, desiredQuantity: String(quantity) }] });
    expect(await counts()).toEqual({ mappings: 1, members: 1, updates: 1, receipts: 1 });
    let now = WALMART_INVENTORY_NOW;
    let reads = 0;
    const methods: string[] = [];
    const api = new WalmartUsApi(new WalmartClient({ clientId: "test", clientSecret: "test",
      market: "us", environment: "sandbox" }, {
      now: () => now,
      fetch: async (url, options) => {
        if (String(url).endsWith("/v3/token")) return Response.json({ access_token: "test-token", expires_in: 3600 });
        expect(new URL(String(url)).searchParams.get("sku")).toBe("P5");
        expect(new URL(String(url)).searchParams.get("shipNode")).toBe("test-location");
        methods.push(options!.method!);
        if (options!.method === "PUT") {
          expect(JSON.parse(String(options!.body))).toEqual({ sku: "P5", quantity: { unit: "EACH", amount: quantity } });
        }
        return Response.json({ sku: "P5", quantity: { unit: "EACH",
          amount: options!.method === "GET" && ++reads === 1 ? 0 : quantity } });
      },
    }));
    const channels = { connection: async () => ({ connection_id: 8, ship_node_id: "test-location", warehouse_id: 1 }),
      requireRuntime: () => undefined, api: () => api,
      repository: { mappings: async () => [{ product_variant_id: 101, channel_sku: "P5" }],
        assertWarehouse: async () => undefined, withLock: async <T>(_channel: number, work: () => Promise<T>) => work() },
    } as unknown as WalmartChannelService;
    const transport = new ChannelInventoryPublicationTransportAdapter(new WalmartAdapter(channels,
      new PostgresInventoryPublicationSupplyReader(database.pool)));
    const worker = new InventoryPublicationOutboxService(new PostgresInventoryPublicationOutboxRepository(database.pool),
      { get: () => transport }, { now: () => now }, () => "walmart-delay-test",
      new PostgresQuantityPublicationAdmission(database.pool, () => now));
    const nextDue = async () => {
      now = (await database.pool.query(`SELECT date_trunc('milliseconds',available_at)+interval '1 millisecond' AS due
        FROM inventory.inventory_publication_outbox WHERE publication_target_id=2 AND state='queued'`)).rows[0].due;
    };
    await nextDue();
    expect(await worker.processDue()).toMatchObject({ claimed: 1, verified: 0, failed: 1 });
    expect(methods).toEqual(["PUT", "GET"]);
    expect((await database.pool.query("SELECT state,error_code FROM inventory.quantity_publication_attempts WHERE owner_kind='outbox'")).rows)
      .toEqual([{ state: "succeeded", error_code: null }]);
    expect((await database.pool.query("SELECT observed_quantity::text,matches_desired FROM inventory.inventory_publication_readbacks WHERE publication_target_id=2")).rows)
      .toEqual([{ observed_quantity: "0", matches_desired: false }]);
    await nextDue();
    expect(await worker.processDue()).toMatchObject({ claimed: 1, verified: 1, failed: 0 });
    expect(methods).toEqual(["PUT", "GET", "PUT", "GET"]);
    expect((await database.pool.query("SELECT observed_quantity::text,matches_desired FROM inventory.inventory_publication_readbacks WHERE publication_target_id=2 ORDER BY id")).rows)
      .toEqual([{ observed_quantity: "0", matches_desired: false }, { observed_quantity: String(quantity), matches_desired: true }]);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.quantity_publication_attempts WHERE state IN ('uncertain','running')")).rows[0].count).toBe(0);
  });

  it.each([
    ["wrong connection", { connectionId: 999 }, "STOCK_LISTING_TARGET_MISMATCH"],
    ["wrong account", { accountId: "other" }, "STOCK_LISTING_ACCOUNT_CHANGED"],
    ["wrong environment", { environment: "sandbox" }, "STOCK_LISTING_ACCOUNT_CHANGED"],
    ["wrong fulfillment center", { externalScopeId: "other" }, "STOCK_LISTING_TARGET_MISMATCH"],
    ["changed provider item", { externalProductId: "OTHER-WPID" }, "STOCK_LISTING_LINK_CHANGED"],
    ["wrong SKU", { sku: "OTHER-SKU" }, "STOCK_LISTING_LINK_CHANGED"],
  ])("rejects %s before any durable change", async (_label, change, code) => {
    await expect(service.connect({ ...input(), ...change })).rejects.toMatchObject({ code });
    expect(await counts()).toEqual({ mappings: 0, members: 0, updates: 0, receipts: 0 });
  });

  it("respects a paused destination", async () => {
    await database.pool.query("UPDATE inventory.inventory_publication_targets SET state='disabled',activated_by=NULL,activated_at=NULL,revision=revision+1 WHERE id=2");
    expect(await service.pending(36, 8, [101])).toEqual([]);
    await expect(service.connect(input())).rejects.toMatchObject({ code: "STOCK_LISTING_TARGET_NOT_READY" });
    expect(await counts()).toEqual({ mappings: 0, members: 0, updates: 0, receipts: 0 });
  });

  it("respects the global pause", async () => {
    await database.pool.query("UPDATE channels.sync_settings SET global_enabled=false");
    expect(await service.pending(36, 8, [101])).toEqual([]);
    await expect(service.connect(input())).rejects.toMatchObject({ code: "STOCK_LISTING_GLOBAL_STOP" });
    expect(await counts()).toEqual({ mappings: 0, members: 0, updates: 0, receipts: 0 });
  });

  it("allows empty reserve warehouse evidence without treating it as stock from another source", async () => {
    await database.pool.query("INSERT INTO warehouse.warehouses(id,code,hub_warehouse_id) VALUES(2,'RESERVE',1)");
    expect(await service.connect(input())).toMatchObject({ state: "connected",
      quantities: [{ productVariantId: 101, desiredQuantity: "17" }] });
    expect(await counts()).toEqual({ mappings: 1, members: 1, updates: 1, receipts: 1 });
  });

  it("connects a valid warehouse with zero ATP and queues zero instead of treating it as a configuration failure", async () => {
    await database.pool.query("UPDATE inventory.inventory_levels SET variant_qty=reserved_qty WHERE warehouse_location_id=100");
    expect(await service.connect(input())).toMatchObject({ state: "connected",
      quantities: [{ productVariantId: 101, desiredQuantity: "0" }] });
    expect(await counts()).toEqual({ mappings: 1, members: 1, updates: 1, receipts: 1 });
    expect((await database.pool.query("SELECT desired_quantity::text FROM inventory.inventory_publication_outbox WHERE publication_target_id=2")).rows)
      .toEqual([{ desired_quantity: "0" }]);
  });

  it.each([
    { source: "inactive reserve", hubWarehouseId: 1, active: false },
    { source: "unrelated warehouse", hubWarehouseId: null, active: true },
  ])("excludes stock in an $source from the Walmart ATP quantity", async ({ hubWarehouseId, active }) => {
    await addWarehouseStock(hubWarehouseId, active);
    expect(await service.connect(input())).toMatchObject({ state: "connected",
      quantities: [{ productVariantId: 101, desiredQuantity: "17" }] });
    expect(await counts()).toEqual({ mappings: 1, members: 1, updates: 1, receipts: 1 });
  });

  it.each([0, 5])("rejects a different configured warehouse before ATP even when it has %i units", async quantity => {
    await addWarehouseStock(null);
    await database.pool.query("UPDATE inventory.inventory_levels SET variant_qty=$1 WHERE warehouse_location_id=200", [quantity]);
    await database.pool.query(`INSERT INTO warehouse.fulfillment_nodes(code,name,node_type,warehouse_id,inventory_authority,fulfillment_authority,created_by)
        VALUES('UNRELATED','Unrelated warehouse','internal_warehouse',2,'echelon','echelon','operator');
      UPDATE warehouse.fulfillment_nodes SET lifecycle_status='active',activated_by='operator',activated_at=transaction_timestamp() WHERE warehouse_id=2;
      INSERT INTO inventory.channel_exposure_policy_versions(scope_key,channel_id,scope_type,product_id,product_variant_id,version,
        source_fulfillment_node_ids,definition_hash,change_reason,idempotency_key,request_hash,created_by)
        SELECT 'channel:36:variant:101',36,'variant',20,101,1,ARRAY[id],repeat('b',64),'Wrong source fixture','source-override',repeat('b',64),'operator'
        FROM warehouse.fulfillment_nodes WHERE warehouse_id=2;
      INSERT INTO inventory.channel_exposure_policy_heads(scope_key,channel_id,draft_policy_id,revision,updated_by,update_reason)
        SELECT scope_key,channel_id,id,1,'operator','Reviewed source fixture' FROM inventory.channel_exposure_policy_versions
        WHERE scope_key='channel:36:variant:101';
      UPDATE inventory.channel_exposure_policy_versions SET lifecycle_status='sealed',sealed_by='operator',sealed_at=transaction_timestamp()
        WHERE scope_key='channel:36:variant:101';
      UPDATE inventory.channel_exposure_policy_heads SET active_policy_id=draft_policy_id,draft_policy_id=NULL,revision=revision+1
        WHERE scope_key='channel:36:variant:101'`);
    await expect(service.connect(input())).rejects.toMatchObject({ code: "STOCK_LISTING_ATP_NOT_READY",
      message: "This SKU's stock source must match the destination's configured fulfillment warehouse." });
    expect(await counts()).toEqual({ mappings: 0, members: 0, updates: 0, receipts: 0 });
  });

  it("preserves an explicit SKU exclusion", async () => {
    await database.pool.query(`WITH inserted AS (INSERT INTO inventory.publication_membership_versions
      (publication_target_id,product_variant_id,version,included,definition_hash,review_hash,created_by,created_at)
      VALUES(2,101,1,false,repeat('b',64),repeat('b',64),'operator',transaction_timestamp()) RETURNING id)
      INSERT INTO inventory.publication_membership_heads SELECT 2,101,id FROM inserted`);
    expect(await service.pending(36, 8, [101])).toEqual([]);
    expect(await service.connect(input())).toMatchObject({ state: "excluded" });
    expect(await counts()).toEqual({ mappings: 0, members: 1, updates: 0, receipts: 0 });
  });

  it("rolls back the new mapping when catalog eligibility prevents enrollment", async () => {
    await database.pool.query("UPDATE catalog.product_variants SET track_inventory=false WHERE id=101");
    await expect(service.connect(input())).rejects.toMatchObject({ code: "STOCK_LISTING_ATP_NOT_READY" });
    expect(await counts()).toEqual({ mappings: 0, members: 0, updates: 0, receipts: 0 });
  });

  it("never promotes an existing draft identity or unrelated settings", async () => {
    await database.pool.query(`WITH inserted AS (INSERT INTO inventory.publication_variant_mapping_versions
      (publication_target_id,product_variant_id,version,external_inventory_item_id,external_sku,definition_hash,change_reason,idempotency_key,request_hash,created_by)
      VALUES(2,101,1,'P5','P5',repeat('b',64),'Manual pending change','pending-map',repeat('b',64),'operator') RETURNING id)
      INSERT INTO inventory.publication_variant_mapping_heads(publication_target_id,product_variant_id,draft_mapping_id,revision,updated_by,update_reason)
      SELECT 2,101,id,1,'operator','Pending mapping' FROM inserted`);
    await expect(service.connect(input())).rejects.toMatchObject({ code: "STOCK_LISTING_MAPPING_REVIEW_REQUIRED" });
    expect(await counts()).toEqual({ mappings: 1, members: 0, updates: 0, receipts: 0 });
    expect((await database.pool.query("SELECT active_mapping_id FROM inventory.publication_variant_mapping_heads WHERE publication_target_id=2")).rows[0].active_mapping_id).toBeNull();
  });

  it("rolls back mapping, membership and queued stock together when audit persistence fails", async () => {
    await database.pool.query(`CREATE FUNCTION public.reject_stock_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='inventory_availability.publication_membership.applied' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_stock_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.reject_stock_audit()`);
    await expect(service.connect(input())).rejects.toThrow("audit unavailable");
    expect(await counts()).toEqual({ mappings: 0, members: 0, updates: 0, receipts: 0 });
  });

  it("keeps concurrent delivery retries idempotent", async () => {
    const outcomes = await Promise.allSettled([service.connect(input()), service.connect(input())]);
    expect(outcomes.some(outcome => outcome.status === "fulfilled")).toBe(true);
    expect(await service.connect(input())).toMatchObject({ state: "already_connected" });
    expect(await counts()).toEqual({ mappings: 1, members: 1, updates: 1, receipts: 1 });
  });
});
