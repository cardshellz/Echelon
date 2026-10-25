import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../fixtures/inventory-cutover-composition-database.fixture";
import { createEbayListingScopeObservation, ebayListingScopeSku as sku, ebayListingScopeSource, installEbayListingScopeFixture } from "../fixtures/ebay-listing-preparation-scope.fixture";
import { installPublicationSelectionWorkFixture } from "../fixtures/publication-selection-work.fixture";
import { ensureEbayPublicationReady } from "../../infrastructure/ebay-publication-readiness.repository";
import { createAuthorityAwareInventoryPublicationService, createInventoryChannelQuantityRuntimeService } from "../../infrastructure/inventory-availability-runtime-publication.repository";
import { createChannelEbayQuantityRequestAdmission, planCurrentCanonicalListingQuantity } from "../../infrastructure/quantity-publication-runtime";
import { PostgresQuantityPublicationAdmission } from "../../infrastructure/quantity-publication-admission.repository";
import { createEbayRouteListingClient } from "../../../channels/infrastructure/ebay-listing-client";
import type { QuantityPublicationScope } from "../../domain/quantity-publication-admission";
import type { EbayOffer } from "../../../channels/adapters/ebay/ebay-types";

// Only the process composition root is redirected: every query, repository,
// planner, admission lock, and journal runs against real disposable PostgreSQL.
const runtime = vi.hoisted(() => ({ pool: null as Pool | null, http: vi.fn() }));
vi.mock("../../../../db", () => ({ pool: new Proxy({} as Pool, { get(_target, key) {
  if (!runtime.pool) throw new Error("Disposable database is not initialized.");
  const value = Reflect.get(runtime.pool, key);
  return typeof value === "function" ? value.bind(runtime.pool) : value;
} }), db: {} }));
vi.mock("../../../channels/infrastructure/ebay-api-runtime", () => ({ EBAY_CHANNEL_ID: 67,
  ebayApiRequest: (...args: unknown[]) => runtime.http(...args),
  ebayApiRequestWithRateNotify: (...args: unknown[]) => runtime.http(...args),
  getAuthService: () => { throw new Error("This fixture supplies its exact verified connection."); },
}));

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = url && disposable ? describe : describe.skip;
const scope = (suffix = "P10", variantId = 101): QuantityPublicationScope => ({
  destinationKind: "channel_connection", connectionId: 9, providerKey: "ebay", providerScopeType: "account",
  externalScopeId: "seller-36", externalInventoryItemId: sku(suffix), productId: 20, productVariantId: variantId,
});
const offer = (suffix: string): EbayOffer => ({ sku: sku(suffix), marketplaceId: "EBAY_US", format: "FIXED_PRICE",
  availableQuantity: 999, categoryId: "1", merchantLocationKey: "main", listingDescription: "Current description",
  pricingSummary: { price: { value: "10.00", currency: "USD" } },
  listingPolicies: { fulfillmentPolicyId: "shipping", paymentPolicyId: "payment", returnPolicyId: "returns" },
});
const quiet = { info: () => {}, warn: () => {} };
function signal() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

dbDescribe.sequential("exact canonical listing refresh through provider admission", () => {
  let database: InventoryCutoverTestDatabase;
  const publisher = () => createAuthorityAwareInventoryPublicationService(database.pool, { logger: quiet });
  const rows = async () => (await database.pool.query(`SELECT to_jsonb(o) AS row
    FROM inventory.inventory_publication_outbox o ORDER BY id`)).rows.map(row => row.row);
  const client = () => createEbayRouteListingClient({ accessToken: "synthetic-test-token",
    quantityAdmission: () => createChannelEbayQuantityRequestAdmission({ channelId: 67,
      externalAccountId: "seller-36", expectedConnectionId: 9 }) });

  // A scheduling barrier only: SQL and returned records are never mocked.
  function pauseAfterSql(fragment: string) {
    const reached = signal(), resume = signal();
    let paused = false;
    runtime.pool = new Proxy(database.pool, { get(target, key) {
      if (key === "connect") return async () => {
        const connected = await target.connect();
        return new Proxy(connected, { get(connection, field) {
          if (field === "query") return async (...args: unknown[]) => {
            const result = await Reflect.apply(connection.query, connection, args);
            if (!paused && String(args[0]).includes(fragment)) { paused = true; reached.release(); await resume.promise; }
            return result;
          };
          const value = Reflect.get(connection, field);
          return typeof value === "function" ? value.bind(connection) : value;
        } });
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    return { reached: reached.promise, resume: resume.release };
  }

  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Live HTTP is prohibited in this suite."); }));
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    runtime.pool = database.pool;
    runtime.http.mockReset().mockResolvedValue(undefined);
    await installEbayListingScopeFixture(database.pool);
    // Shopify and eBay are both live. The archived member has a retained
    // Shopify identity but no active inventory mapping; Listings owns removal.
    await database.pool.query(`UPDATE inventory.inventory_publication_targets SET state='live',revision=revision+1 WHERE id=1;
      INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_variant_id,channel_inventory_item_id,channel_sku)
        VALUES(35,101,'shopify-P10','test-item','P5'),(35,103,'shopify-retired-C200',NULL,'SHLZ-TOP-260PT-C200')`);
    await publisher().publishProduct({ productId: 20, publicationTargetId: 1, productVariantIds: [101], dryRun: false }, async () => null);
  }, 60_000);
  afterEach(async () => { await database?.close(); runtime.pool = null; vi.unstubAllGlobals(); });

  it("scopes an offer update after verified preparation without touching Shopify or the retired member", async () => {
    const f = await createEbayListingScopeObservation(database.pool), observed = await f.observe();
    await ensureEbayPublicationReady(database.pool, ebayListingScopeSource(), { commandKey: randomUUID(), actor: "scope-test",
      now: new Date(), verifiedListing: { sourceIdentity: f.source, observation: observed.observation } });
    const before = await rows();
    expect(before.some(row => row.publication_target_id === 1)).toBe(true);
    expect((await database.pool.query(`SELECT active_mapping_id FROM inventory.publication_variant_mapping_heads
      WHERE publication_target_id=1 AND product_variant_id=103`)).rows).toEqual([]);
    const quantities = await createInventoryChannelQuantityRuntimeService(database.pool, quiet).readProduct({
      productId: 20, channelId: 67, target: { destinationKind: "channel_connection", connectionId: 9,
        providerKey: "ebay", providerScopeType: "account", externalScopeId: "seller-36" }, triggeredBy: "test-read" }, async () => []);
    expect(quantities.authority).toBe("canonical");
    if (quantities.authority !== "canonical") throw new Error("Fixture must use canonical quantities.");
    await client().updateOffer("offer-P10", offer("P10"));
    await client().updateOffer("offer-C500", offer("C500"));
    expect(runtime.http.mock.calls.map(call => ({ method: call[0], path: call[1], quantity: call[3].availableQuantity })))
      .toEqual([101, 102].map((variantId, index) => ({ method: "PUT", path: `/sell/inventory/v1/offer/offer-${index === 0 ? "P10" : "C500"}`,
        quantity: quantities.rows.find(row => row.productVariantId === variantId)!.quantity })));
    expect(await rows()).toEqual(before);
    expect((await database.pool.query("SELECT state,scope,planned_outbox_id FROM inventory.quantity_publication_attempts ORDER BY id")).rows)
      .toEqual(["P10", "C500"].map(suffix => expect.objectContaining({ state: "succeeded",
        scope: expect.objectContaining({ providerKey: "ebay", externalInventoryItemId: sku(suffix) }), planned_outbox_id: expect.any(String) })));
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.quantity_provider_requests")).rows[0].n).toBe(2);
  });

  it("excludes archived members from a full product refresh across both live channels", async () => {
    const result = await publisher().publishProduct({ productId: 20, dryRun: false }, async () => null);
    expect(result.authority).toBe("canonical");
    if (result.authority !== "canonical") throw new Error("Fixture must use canonical publication.");
    expect(result.publication.rows.map(row => [row.publicationTargetId, row.productVariantId]).sort())
      .toEqual([[1, 101], [3, 101], [3, 102]]);
    expect((await rows()).some(row => row.product_variant_id === 103)).toBe(false);
    expect((await database.pool.query(`SELECT publication_target_id FROM inventory.publication_variant_mapping_heads
      WHERE product_variant_id=103`)).rows).toEqual([]);
    expect(runtime.http).not.toHaveBeenCalled();
  });

  it.each([
    { providerKey: "walmart" as const }, { productId: 999 }, { productVariantId: 102 },
    { externalScopeId: "another-seller" }, { connectionId: 7 }, { destinationKind: "dropship_store_connection" as const },
  ])("rejects a mismatched exact scope before any publication write: %j", async changed => {
    const before = await rows();
    await expect(planCurrentCanonicalListingQuantity({ ...scope(), ...changed }))
      .rejects.toMatchObject({ code: "PUBLICATION_LISTING_TARGET_UNMAPPED" });
    expect(await rows()).toEqual(before);
    expect(runtime.http).not.toHaveBeenCalled();
  });

  it("preserves the global stop before planning or HTTP", async () => {
    await database.pool.query("UPDATE channels.sync_settings SET global_enabled=false");
    const before = await rows();
    await expect(client().updateOffer("offer-P10", offer("P10"))).rejects.toMatchObject({ code: "PUBLICATION_GLOBAL_STOP_ACTIVE" });
    expect(await rows()).toEqual(before);
    expect(runtime.http).not.toHaveBeenCalled();
  });

  it("refreshes the exact Shopify catchup item without expanding to retired Shopify or eBay members", async () => {
    const before = await rows();
    const plan = await planCurrentCanonicalListingQuantity({ ...scope(), connectionId: 7, providerKey: "shopify",
      providerScopeType: "location", externalScopeId: "test-location", externalInventoryItemId: "test-item" });
    expect(plan.quantity).toBe(17);
    expect(before.find(row => String(row.id) === plan.outboxId)).toMatchObject({ publication_target_id: 1, product_variant_id: 101 });
    expect(await rows()).toEqual(before);
  });

  it("resolves the exact Dropship store platform independently of its logical policy channel", async () => {
    await installPublicationSelectionWorkFixture(database.pool);
    const connection = await database.pool.connect();
    let targetId: number;
    try {
      await connection.query("BEGIN");
      await connection.query(`INSERT INTO dropship.dropship_vendors(id,business_name) VALUES(10,'Scope test vendor');
        INSERT INTO dropship.dropship_store_connections(id,vendor_id,platform,status,external_account_id,provider_environment)
          VALUES(22,10,'ebay','connected','dropship-seller','production');
        INSERT INTO dropship.dropship_store_listing_configs(id,store_connection_id,platform,listing_mode,inventory_mode,is_active)
          VALUES(1,22,'ebay','live','managed_quantity_sync',true);
        INSERT INTO dropship.dropship_catalog_rules(id,scope_type,action,is_active,priority)
          VALUES(1,'catalog','include',true,0);
        -- The vendor's picks: every catalog size, as the conversion turns a 'catalog' include (PLAN-B v4.1 §6 step 4).
        INSERT INTO dropship.dropship_vendor_selected_variants(vendor_id,product_variant_id) SELECT 10, id FROM catalog.product_variants;
        INSERT INTO dropship.dropship_vendor_listings(id,vendor_id,store_connection_id,product_variant_id,platform,status,external_listing_id,external_offer_id,updated_at)
          VALUES(1,10,22,101,'ebay','active','dropship-listing','dropship-offer',transaction_timestamp())`);
      // Channel 35 supplies allocation policy and is Shopify. The exact store's
      // eBay platform must own transport identity in the resolver and outbox.
      targetId = (await connection.query<{ id: number }>(`INSERT INTO inventory.inventory_publication_targets
        (destination_kind,channel_id,dropship_store_connection_id,fulfillment_node_id,provider_scope_type,external_scope_id,
          publication_authority,state,change_reason,created_by)
        VALUES('dropship_store_connection',35,22,1,'account','dropship-seller','echelon','disabled','Exact store fixture','fixture')
        RETURNING id`)).rows[0]!.id;
      const binding = (await connection.query<{ id: string }>(`INSERT INTO inventory.publication_source_binding_versions
        (publication_target_id,version,definition_hash,change_reason,idempotency_key,request_hash,created_by)
        VALUES($1,1,repeat('b',64),'Dropship warehouse','scope-dropship-binding',repeat('b',64),'fixture') RETURNING id::text`, [targetId])).rows[0]!;
      await connection.query(`INSERT INTO inventory.publication_source_binding_heads(publication_target_id,draft_binding_id,revision,updated_by,update_reason)
        VALUES($1,$2,1,'fixture','Exact store source')`, [targetId, binding.id]);
      await connection.query(`INSERT INTO inventory.publication_source_binding_members(binding_id,publication_target_id,fulfillment_node_id,priority)
        VALUES($1,$2,1,1)`, [binding.id, targetId]);
      await connection.query("UPDATE inventory.publication_source_binding_versions SET lifecycle_status='sealed',sealed_by='fixture',sealed_at=transaction_timestamp() WHERE id=$1", [binding.id]);
      await connection.query(`UPDATE inventory.publication_source_binding_heads SET active_binding_id=draft_binding_id,draft_binding_id=NULL,revision=revision+1
        WHERE publication_target_id=$1`, [targetId]);
      const mapping = (await connection.query<{ id: string }>(`INSERT INTO inventory.publication_variant_mapping_versions
        (publication_target_id,product_variant_id,version,external_inventory_item_id,external_sku,definition_hash,change_reason,idempotency_key,request_hash,created_by)
        VALUES($1,101,1,'DROP-P10','DROP-P10',repeat('d',64),'Exact store item','scope-dropship-mapping',repeat('d',64),'fixture') RETURNING id::text`, [targetId])).rows[0]!;
      await connection.query(`INSERT INTO inventory.publication_variant_mapping_heads(publication_target_id,product_variant_id,draft_mapping_id,revision,updated_by,update_reason)
        VALUES($1,101,$2,1,'fixture','Exact store item')`, [targetId, mapping.id]);
      await connection.query("UPDATE inventory.publication_variant_mapping_versions SET lifecycle_status='sealed',sealed_by='fixture',sealed_at=transaction_timestamp() WHERE id=$1", [mapping.id]);
      await connection.query(`UPDATE inventory.publication_variant_mapping_heads SET active_mapping_id=draft_mapping_id,draft_mapping_id=NULL,revision=revision+1
        WHERE publication_target_id=$1 AND product_variant_id=101`, [targetId]);
      await connection.query(`UPDATE inventory.inventory_publication_targets SET state='preview',revision=revision+1,
        activated_by='fixture',activated_at=transaction_timestamp() WHERE id=$1`, [targetId]);
      await connection.query("UPDATE inventory.inventory_publication_targets SET state='live',revision=revision+1 WHERE id=$1", [targetId]);
      await connection.query("COMMIT");
    } catch (error) { await connection.query("ROLLBACK"); throw error; }
    finally { connection.release(); }
    const requested: QuantityPublicationScope = { ...scope(), destinationKind: "dropship_store_connection",
      connectionId: 22, externalScopeId: "dropship-seller", externalInventoryItemId: "DROP-P10" };
    const before = await rows();
    await expect(planCurrentCanonicalListingQuantity({ ...requested, providerKey: "shopify" }))
      .rejects.toMatchObject({ code: "PUBLICATION_LISTING_TARGET_UNMAPPED" });
    expect(await rows()).toEqual(before);
    const planned = await planCurrentCanonicalListingQuantity(requested);
    expect(planned.quantity).toBe(17);
    const after = await rows();
    expect(after.filter(row => row.publication_target_id !== targetId)).toEqual(before);
    expect(after.filter(row => row.publication_target_id === targetId)).toEqual([expect.objectContaining({
      id: Number(planned.outboxId), product_variant_id: 101, destination_kind_snapshot: "dropship_store_connection",
      channel_connection_id_snapshot: null, dropship_store_connection_id_snapshot: 22, provider_key_snapshot: "ebay",
      external_scope_id_snapshot: "dropship-seller", external_inventory_item_id_snapshot: "DROP-P10", desired_quantity: 17,
    })]);
    await expect(planCurrentCanonicalListingQuantity(requested)).resolves.toEqual(planned);
    expect(await rows()).toEqual(after);
    expect(runtime.http).not.toHaveBeenCalled();
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.quantity_publication_attempts")).rows[0].n).toBe(0);
  });

  it("rejects duplicate external routing even when local IDs select only one of the mappings", async () => {
    await database.pool.query(`INSERT INTO warehouse.warehouses(id,code) VALUES(2,'SECOND');
      INSERT INTO warehouse.fulfillment_nodes(code,name,node_type,warehouse_id,inventory_authority,fulfillment_authority,created_by)
        VALUES('SECOND','Second source','internal_warehouse',2,'echelon','echelon','fixture');
      UPDATE warehouse.fulfillment_nodes SET lifecycle_status='active',activated_by='fixture',activated_at=transaction_timestamp() WHERE code='SECOND';
      INSERT INTO catalog.products(id,sku) VALUES(30,'OTHER');
      INSERT INTO catalog.product_variants(id,product_id,sku) VALUES(301,30,'OTHER-P10');`);
    const target = (await database.pool.query<{ id: number }>(`INSERT INTO inventory.inventory_publication_targets
      (channel_id,channel_connection_id,fulfillment_node_id,provider_scope_type,external_scope_id,publication_authority,state,change_reason,created_by)
      SELECT 67,9,id,'account','seller-36','echelon','disabled','Ambiguous external fixture','fixture'
      FROM warehouse.fulfillment_nodes WHERE code='SECOND' RETURNING id`)).rows[0];
    await database.pool.query(`UPDATE inventory.inventory_publication_targets SET state='preview',revision=revision+1,
      activated_by='fixture',activated_at=transaction_timestamp() WHERE id=$1`, [target.id]);
    await database.pool.query("UPDATE inventory.inventory_publication_targets SET state='live',revision=revision+1 WHERE id=$1", [target.id]);
    const connection = await database.pool.connect();
    try {
      await connection.query("BEGIN");
      const mapping = (await connection.query<{ id: number }>(`INSERT INTO inventory.publication_variant_mapping_versions
        (publication_target_id,product_variant_id,version,external_inventory_item_id,external_sku,definition_hash,change_reason,idempotency_key,request_hash,created_by)
        VALUES($1,301,1,$2,$2,repeat('d',64),'Duplicate external identity','duplicate-external',repeat('d',64),'fixture') RETURNING id`, [target.id, sku("P10")])).rows[0];
      await connection.query(`INSERT INTO inventory.publication_variant_mapping_heads(publication_target_id,product_variant_id,draft_mapping_id,revision,updated_by,update_reason)
        VALUES($1,301,$2,1,'fixture','Duplicate external identity')`, [target.id, mapping.id]);
      await connection.query("UPDATE inventory.publication_variant_mapping_versions SET lifecycle_status='sealed',sealed_by='fixture',sealed_at=transaction_timestamp() WHERE id=$1", [mapping.id]);
      await connection.query(`UPDATE inventory.publication_variant_mapping_heads SET active_mapping_id=draft_mapping_id,draft_mapping_id=NULL,revision=revision+1
        WHERE publication_target_id=$1 AND product_variant_id=301`, [target.id]);
      await connection.query("COMMIT");
    } catch (error) { await connection.query("ROLLBACK"); throw error; }
    finally { connection.release(); }
    const before = await rows();
    for (const requested of [scope(), { ...scope(), productId: null, productVariantId: null }, { ...scope(), productId: 30, productVariantId: 301 }]) {
      await expect(planCurrentCanonicalListingQuantity(requested)).rejects.toMatchObject({ code: "PUBLICATION_LISTING_TARGET_UNMAPPED" });
    }
    expect(await rows()).toEqual(before);
    expect(runtime.http).not.toHaveBeenCalled();
  });

  it("refreshes each verified group member without expanding its canonical publication scope", async () => {
    runtime.http.mockImplementation(async (method: string, path: string, _token: string, body: Record<string, unknown>) => {
      if (method === "GET" && path.includes("/inventory_item/")) return { sku: decodeURIComponent(path.split("/").at(-1)!),
        availability: { shipToLocationAvailability: { quantity: 999 } } };
      if (method === "GET" && path.includes("/offer?")) {
        const memberSku = new URL(path, "https://example.test").searchParams.get("sku")!;
        return { offers: [{ sku: memberSku, offerId: `offer-${memberSku}`, marketplaceId: "EBAY_US" }], total: 1 };
      }
      if (path.includes("bulk_update_price_quantity")) {
        const requests = body.requests as Array<{ sku: string; offers: Array<{ offerId: string }> }>;
        return { responses: requests.flatMap(request => request.offers.map(member => ({ sku: request.sku, offerId: member.offerId, statusCode: 200 }))) };
      }
      if (method === "PUT" && path.endsWith("/inventory_item_group/SHLZ-TOP-260PT")) return undefined;
      throw new Error(`Unexpected provider request: ${method} ${path}`);
    });
    const before = await rows();
    await client().createOrReplaceInventoryItemGroup("SHLZ-TOP-260PT", { title: "Current group", description: "Current content",
      aspects: {}, imageUrls: [], variantSKUs: [sku("P10"), sku("C500")], variesBy: { specifications: [] } });
    expect(await rows()).toEqual(before);
    expect(runtime.http.mock.calls.filter(call => call[0] !== "GET").map(call => call[1])).toEqual([
      "/sell/inventory/v1/bulk_update_price_quantity", "/sell/inventory/v1/bulk_update_price_quantity",
      "/sell/inventory/v1/inventory_item_group/SHLZ-TOP-260PT",
    ]);
    const attempt = (await database.pool.query("SELECT state,affected_scopes,planned_outbox_ids FROM inventory.quantity_publication_attempts")).rows[0];
    expect(attempt.state).toBe("succeeded");
    expect(attempt.planned_outbox_ids).toHaveLength(2);
    expect(attempt.affected_scopes.map((member: QuantityPublicationScope) => member.externalInventoryItemId).sort())
      .toEqual([sku("P10"), sku("C500"), "group:SHLZ-TOP-260PT"].sort());
  });

  it.each(["target", "mapping"])("rolls back when a concurrent %s change invalidates the resolved snapshot", async changed => {
    const before = await rows(), barrier = pauseAfterSql("FROM inventory.availability_runtime_authority");
    const pending = planCurrentCanonicalListingQuantity(scope()).then(value => ({ value }), error => ({ error }));
    try {
      await barrier.reached;
      if (changed === "target") await database.pool.query("UPDATE inventory.inventory_publication_targets SET revision=revision+1 WHERE id=3");
      else await database.pool.query(`UPDATE inventory.publication_variant_mapping_heads SET active_mapping_id=NULL,revision=revision+1
        WHERE publication_target_id=3 AND product_variant_id=101`);
    } finally { barrier.resume(); }
    expect(await pending).toMatchObject({ error: { code: "40001" } });
    expect(await rows()).toEqual(before);
    expect(runtime.http).not.toHaveBeenCalled();
  });

  it("holds the mapping, target, Catalog parent and connection stable until local planning completes", async () => {
    const barrier = pauseAfterSql("LIMIT 2 FOR SHARE OF t,h,m,v");
    const pending = planCurrentCanonicalListingQuantity(scope());
    const other = await database.pool.connect();
    try {
      await barrier.reached;
      for (const statement of ["UPDATE inventory.inventory_publication_targets SET revision=revision+1 WHERE id=3",
        "UPDATE inventory.publication_variant_mapping_heads SET active_mapping_id=NULL,revision=revision+1 WHERE publication_target_id=3 AND product_variant_id=101",
        "SELECT id FROM catalog.products WHERE id=20 FOR UPDATE",
        "SELECT id FROM channels.channel_connections WHERE id=9 FOR UPDATE"]) {
        await other.query("BEGIN");
        await other.query("SET LOCAL lock_timeout='100ms'");
        await expect(other.query(statement)).rejects.toMatchObject({ code: "55P03" });
        await other.query("ROLLBACK");
      }
    } finally { other.release(); barrier.resume(); }
    await expect(pending).resolves.toMatchObject({ quantity: 17, outboxId: expect.any(String) });
  });

  it("rejects a target revision change between planning and final provider admission", async () => {
    const before = await rows();
    await expect(new PostgresQuantityPublicationAdmission(database.pool).runListing(scope(), async () => {
      const plan = await planCurrentCanonicalListingQuantity(scope());
      await database.pool.query("UPDATE inventory.inventory_publication_targets SET revision=revision+1 WHERE id=3");
      return plan;
    }, async () => runtime.http("PUT", "/should-not-send")))
      .rejects.toMatchObject({ code: "PUBLICATION_CANONICAL_LISTING_PLAN_CHANGED" });
    expect(await rows()).toEqual(before);
    expect(runtime.http).not.toHaveBeenCalled();
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.quantity_publication_attempts")).rows[0].n).toBe(0);
  });

  it("rolls back queued replacement and supersession if final database validation fails", async () => {
    // The changed target revision requires a new desired row even though ATP
    // remains 17. A real deferred PostgreSQL constraint rejects that new row at
    // COMMIT, after planning and exact handoff validation have both completed.
    await database.pool.query("UPDATE inventory.inventory_publication_targets SET revision=revision+1 WHERE id=3");
    await database.pool.query(`CREATE FUNCTION inventory.reject_fixture_listing_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Synthetic final desired-state validation failure'; END $$;
      CREATE CONSTRAINT TRIGGER reject_fixture_listing_handoff AFTER INSERT ON inventory.inventory_publication_outbox
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.publication_target_id=3 AND NEW.product_variant_id=101)
      EXECUTE FUNCTION inventory.reject_fixture_listing_handoff()`);
    const before = await rows();
    await expect(client().updateOffer("offer-P10", offer("P10"))).rejects.toMatchObject({ code: "23514" });
    expect(await rows()).toEqual(before);
    expect(runtime.http).not.toHaveBeenCalled();
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.quantity_publication_attempts")).rows[0].n).toBe(0);
    await database.pool.query("DROP TRIGGER reject_fixture_listing_handoff ON inventory.inventory_publication_outbox");
    await client().updateOffer("offer-P10", offer("P10"));
    const after = await rows();
    const unrelated = (saved: typeof before) => saved.filter(row => row.publication_target_id !== 3 || row.product_variant_id !== 101);
    expect(unrelated(after)).toEqual(unrelated(before));
    expect(after.filter(row => row.publication_target_id === 3 && row.product_variant_id === 101))
      .toEqual([expect.objectContaining({ state: "superseded" }), expect.objectContaining({ state: "queued", desired_quantity: 17 })]);
    expect(runtime.http).toHaveBeenCalledOnce();
  });

  it("retains the exact provider scope lock while HTTP is in flight", async () => {
    const reached = signal(), resume = signal();
    runtime.http.mockImplementationOnce(async () => { reached.release(); await resume.promise; });
    const pending = client().updateOffer("offer-P10", offer("P10"));
    try {
      await reached.promise;
      await expect(client().updateOffer("offer-P10", offer("P10"))).rejects.toMatchObject({ code: "PUBLICATION_SCOPE_BUSY" });
      expect(runtime.http).toHaveBeenCalledOnce();
    } finally { resume.release(); }
    await pending;
    expect((await database.pool.query("SELECT state FROM inventory.quantity_publication_attempts")).rows).toEqual([{ state: "succeeded" }]);
    expect((await database.pool.query("SELECT scope,reason FROM inventory.quantity_publication_catchup")).rows)
      .toEqual([expect.objectContaining({ scope: expect.objectContaining({ externalInventoryItemId: sku("P10") }), reason: "publication_scope_busy" })]);
  });

  it("allows exact canonical catchup while group planning owns its admission connection", async () => {
    const barrier = pauseAfterSql("FROM inventory.availability_runtime_authority");
    const admission = await createChannelEbayQuantityRequestAdmission({ channelId: 67, externalAccountId: "seller-36", expectedConnectionId: 9 });
    const group = admission.group("SHLZ-TOP-260PT", [sku("P10"), sku("C500")], async quantities => {
      expect(quantities?.get(sku("P10"))).toBe(17);
      expect(quantities?.get(sku("C500"))).toBe(0);
    });
    try {
      await barrier.reached;
      await expect(planCurrentCanonicalListingQuantity({ ...scope(), connectionId: 7, providerKey: "shopify",
        providerScopeType: "location", externalScopeId: "test-location", externalInventoryItemId: "test-item" }))
        .resolves.toMatchObject({ quantity: 17 });
    } finally { barrier.resume(); }
    await group;
    const configuredPool = database.pool as Pool & { options?: { max?: number } };
    expect(configuredPool.options?.max).toBe(4);
    expect((await database.pool.query("SELECT state FROM inventory.quantity_publication_attempts")).rows).toEqual([{ state: "succeeded" }]);
  });
});
