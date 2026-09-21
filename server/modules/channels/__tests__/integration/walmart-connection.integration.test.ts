import { readFileSync } from "node:fs";
import { beforeAll, afterAll, expect, it } from "vitest";
import { describeWithDisposableDb, getTestPool, closeTestDb } from "../../../../../test/setup-integration";
import { WalmartConnectionRepository } from "../../adapters/walmart/walmart-connection.repository";
import { AesGcmFulfillmentProviderCredentialCipher } from "../../../shipping-engine/infrastructure/fulfillment-provider-credential-cipher";
import { parseWalmartOrder } from "../../adapters/walmart/walmart-us-api";
import { mapWalmartOrder } from "../../adapters/walmart/walmart-order.domain";
import { walmartOrderFixture } from "../unit/walmart-fixture";

function migrationTable(file: string, name: string): string {
  const sql = readFileSync(file, "utf8");
  const start = sql.indexOf(`CREATE TABLE ${name} (`);
  if (start < 0) throw new Error(`Migration does not define ${name}`);
  const definition = sql.slice(start);
  const end = /\r?\n\s*\);/.exec(definition);
  if (!end) throw new Error(`Unterminated migration table ${name}`);
  return definition.slice(0, end.index + end[0].length);
}

describeWithDisposableDb("Walmart account and order PostgreSQL transactions", () => {
  const now = new Date("2026-09-21T12:00:00Z");
  const cipher = new AesGcmFulfillmentProviderCredentialCipher(Buffer.alloc(32, 7), "test-key");
  let repository: WalmartConnectionRepository;
  let channelId: number, otherChannelId: number, warehouseId: number, variantId: number;
  const command = () => ({ clientId: "test", clientSecret: "secret", environment: "production" as const,
    expectedPartnerId: "PARTNER-1", shipNodeId: "NODE-1", warehouseId, importSince: "2026-09-20T12:00:00.000Z" });
  const seal = (connectionId: number) => cipher.seal({ connectionId, provider: "walmart", credential: "secret" });
  beforeAll(async () => {
    const pool = getTestPool();
    // Use the shared disposable contract, actual historical table DDL, and the
    // actual new migration. Only later additive columns are fixture projections.
    await pool.query(readFileSync("test/fixtures/named-schema-integration.sql", "utf8"));
    await pool.query("SET search_path TO channels,public");
    await pool.query(migrationTable("migrations/0001_past_molly_hayes.sql", '"channel_connections"'));
    await pool.query(migrationTable("migrations/0001_past_molly_hayes.sql", '"channel_feeds"').replaceAll('"variant_id"', '"product_variant_id"'));
    await pool.query(`ALTER TABLE channels.channel_feeds ADD COLUMN channel_id integer REFERENCES channels.channels(id),
      ADD COLUMN channel_inventory_item_id varchar(100), ADD COLUMN quarantined_at timestamp;
      CREATE UNIQUE INDEX ON channels.channel_feeds(channel_id,product_variant_id);
      CREATE UNIQUE INDEX ON channels.channel_connections(id,channel_id);`);
    for (const name of ['"oms"."oms_orders"', '"oms"."oms_order_lines"', '"oms"."oms_order_events"']) {
      await pool.query(migrationTable("migrations/0002_concerned_darwin.sql", name));
    }
    await pool.query(`ALTER TABLE oms.oms_order_lines ADD COLUMN paid_quantity integer NOT NULL DEFAULT 0,
      ADD COLUMN authority_fulfillable_quantity integer NOT NULL DEFAULT 0, ADD COLUMN cancelled_quantity integer NOT NULL DEFAULT 0,
      ADD COLUMN refunded_quantity integer NOT NULL DEFAULT 0, ADD COLUMN authorization_status varchar(30) NOT NULL DEFAULT 'seen';`);
    await pool.query(readFileSync("migrations/248_walmart_direct_channel.sql", "utf8"));
    await pool.query(migrationTable("migrations/211_inventory_availability_foundation.sql", "warehouse.fulfillment_nodes"));
    await pool.query(migrationTable("migrations/0623_inventory_claim_simulation_activation_outbox.sql", "inventory.inventory_publication_targets"));
    await pool.query("ALTER TABLE inventory.inventory_publication_targets ADD COLUMN destination_kind varchar(40) NOT NULL DEFAULT 'channel_connection'");
    for (const name of ["versions", "members", "heads"]) {
      await pool.query(migrationTable("migrations/0632_inventory_channel_exposure_policy.sql", `inventory.publication_source_binding_${name}`));
    }
    channelId = (await pool.query("INSERT INTO channels.channels(name,provider) VALUES('Walmart','walmart') RETURNING id")).rows[0].id;
    otherChannelId = (await pool.query("INSERT INTO channels.channels(name,provider) VALUES('Other','walmart') RETURNING id")).rows[0].id;
    warehouseId = (await pool.query("INSERT INTO warehouse.warehouses(code,name) VALUES('WM','Test warehouse') RETURNING id")).rows[0].id;
    const productId = (await pool.query("INSERT INTO catalog.products(sku,name) VALUES('PRODUCT','Product') RETURNING id")).rows[0].id;
    variantId = (await pool.query("INSERT INTO catalog.product_variants(product_id,sku,name) VALUES($1,'ECHELON-SKU','Variant') RETURNING id", [productId])).rows[0].id;
    repository = new WalmartConnectionRepository(pool);
  });
  afterAll(closeTestDb);

  it("rolls back failed credential sealing without leaving an unmanaged connection", async () => {
    await expect(repository.save(command(), channelId, "Seller", "operator", now, () => { throw new Error("vault failed"); })).rejects.toThrow("vault failed");
    expect((await getTestPool().query("SELECT id FROM channels.channel_connections")).rowCount).toBe(0);
  });
  it("stores encrypted credentials, scoped identity, paused intake and an immutable audit", async () => {
    await repository.save(command(), channelId, "Seller", "operator", now, seal);
    const row = (await repository.get(channelId))!;
    expect(row.orders_enabled).toBe(false);
    expect(JSON.stringify(row.encrypted_credentials)).not.toContain('"secret"');
    expect(await repository.status(channelId)).not.toHaveProperty("encrypted_credentials");
    await repository.assertWarehouse(row);
    expect(await repository.resolveWarehouse(channelId)).toEqual({ warehouseId, warehouseType: "operations" });
    await expect(getTestPool().query("UPDATE channels.walmart_connection_events SET actor='changed'")).rejects.toThrow(/immutable/);
  });
  it("prevents the same account being connected to another channel and rolls back its connection", async () => {
    await expect(repository.save(command(), otherChannelId, "Seller", "operator", now, seal)).rejects.toMatchObject({ code: "23505" });
    expect((await getTestPool().query("SELECT id FROM channels.channel_connections WHERE channel_id=$1", [otherChannelId])).rowCount).toBe(0);
  });
  it("rejects account identity replacement", async () => {
    await expect(repository.save({ ...command(), shipNodeId: "OTHER" }, channelId, "Seller", "operator", now, seal)).rejects.toMatchObject({ code: "WALMART_CONNECTION_IDENTITY_CONFLICT" });
  });
  it("links exact SKU identities idempotently and rejects remapping", async () => {
    await Promise.all([1, 2].map(() => repository.linkSku(channelId, variantId, "WALMART-SKU", "operator", now)));
    expect(await repository.mappings(channelId)).toHaveLength(1);
    await expect(repository.linkSku(channelId, variantId, "DIFFERENT", "operator", now)).rejects.toMatchObject({ code: "WALMART_MAPPING_CONFLICT" });
  });
  it("allows only one concurrent revision update", async () => {
    const revision = (await repository.get(channelId))!.revision;
    const results = await Promise.allSettled([true, false].map(enabled => repository.control(channelId, enabled, revision, "operator", now)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  });
  it("uses a cross-session channel lock", async () => {
    await repository.withLock(channelId, async () => {
      await expect(repository.withLock(channelId, async () => undefined)).rejects.toMatchObject({ code: "WALMART_CHANNEL_BUSY" });
    });
    await expect(repository.withLock(channelId, async () => 7)).resolves.toBe(7);
  });
  it("reconciles cancellation and receipts without reversing prior dispositions", async () => {
    const pool = getTestPool();
    const orderId = Number((await pool.query("INSERT INTO oms.oms_orders(channel_id,external_order_id,ordered_at,subtotal_cents,tax_cents,total_cents) VALUES($1,'PO-123',$2,1999,120,2119) RETURNING id", [channelId, now])).rows[0].id);
    await pool.query("INSERT INTO oms.oms_order_lines(order_id,external_line_item_id,sku,title,quantity,paid_quantity,authority_fulfillable_quantity,paid_price_cents,total_price_cents) VALUES($1,'1','WALMART-SKU','Test',1,1,1,1999,1999)", [orderId]);
    const order = parseWalmartOrder(walmartOrderFixture("Cancelled"));
    await expect(repository.reconcileOrderState(orderId, order, { ...mapWalmartOrder(order, "NODE-1", true), totalCents: 1 }, now))
      .rejects.toMatchObject({ code: "WALMART_FINANCIAL_DRIFT" });
    await repository.reconcileOrderState(orderId, order, mapWalmartOrder(order, "NODE-1", true), now);
    expect((await pool.query("SELECT cancelled_quantity,authority_fulfillable_quantity FROM oms.oms_order_lines WHERE order_id=$1", [orderId])).rows[0]).toEqual({ cancelled_quantity: 1, authority_fulfillable_quantity: 0 });
    const stale = parseWalmartOrder(walmartOrderFixture("Acknowledged"));
    await expect(repository.reconcileOrderState(orderId, stale, mapWalmartOrder(stale, "NODE-1", true), now)).rejects.toMatchObject({ code: "WALMART_AUTHORITY_CONFLICT" });
    await repository.recordReceipt(channelId, "PO-123", "a".repeat(64), "completed", orderId, null, now);
    expect((await repository.receipt(channelId, "PO-123"))?.oms_order_id).toBe(orderId);
    expect((await pool.query("SELECT status FROM oms.oms_orders WHERE id=$1", [orderId])).rows[0].status).toBe("cancelled");
    expect(await repository.findOrder(channelId, "PO-123")).toBe(orderId);
    await repository.recordReceipt(channelId, "PO-REVIEW", "b".repeat(64), "failed", null, "WALMART_MULTI_QUANTITY_REVIEW", now);
    expect(await repository.exceptions(channelId)).toEqual([{ purchaseOrderId: "PO-REVIEW", errorCode: "WALMART_MULTI_QUANTITY_REVIEW", observedAt: now.toISOString() }]);
    await repository.markPoll(channelId, now, { checkpoint: now });
    expect((await repository.status(channelId))?.lastSuccessAt).toBe(now.toISOString());
  });
  it("allows stock only from the bound warehouse's active, sealed source binding", async () => {
    const pool = getTestPool(), row = (await repository.get(channelId))!;
    await expect(repository.assertInventorySupply(row)).rejects.toMatchObject({ code: "WALMART_INVENTORY_SUPPLY_MISMATCH" });
    const node = (await pool.query(`INSERT INTO warehouse.fulfillment_nodes(code,name,node_type,warehouse_id,inventory_authority,fulfillment_authority,lifecycle_status,created_by,activated_by,activated_at)
      VALUES('WALMART-NODE','Test node','internal_warehouse',$1,'echelon','echelon','active','operator','operator',$2) RETURNING id`, [warehouseId, now])).rows[0].id;
    const target = (await pool.query(`INSERT INTO inventory.inventory_publication_targets(channel_id,channel_connection_id,fulfillment_node_id,provider_scope_type,external_scope_id,publication_authority,change_reason,created_by)
      VALUES($1,$2,$3,'location','NODE-1','echelon','test','operator') RETURNING id`, [channelId,row.connection_id,node])).rows[0].id;
    const binding = (await pool.query(`INSERT INTO inventory.publication_source_binding_versions(publication_target_id,version,lifecycle_status,definition_hash,request_hash,change_reason,idempotency_key,created_by,sealed_by,sealed_at)
      VALUES($1,1,'sealed',$2,$2,'test','test-binding','operator','operator',$3) RETURNING id`, [target, "a".repeat(64), now])).rows[0].id;
    await pool.query("INSERT INTO inventory.publication_source_binding_members(binding_id,publication_target_id,fulfillment_node_id,priority) VALUES($1,$2,$3,1)", [binding,target,node]);
    await pool.query("INSERT INTO inventory.publication_source_binding_heads(publication_target_id,active_binding_id,updated_by,update_reason) VALUES($1,$2,'operator','test')", [target,binding]);
    await expect(repository.assertInventorySupply(row)).resolves.toBeUndefined();
    const other = (await pool.query("INSERT INTO warehouse.warehouses(code,name) VALUES('OTHER','Other warehouse') RETURNING id")).rows[0].id;
    await pool.query("UPDATE warehouse.fulfillment_nodes SET warehouse_id=$1 WHERE id=$2", [other,node]);
    await expect(repository.assertInventorySupply(row)).rejects.toMatchObject({ code: "WALMART_INVENTORY_SUPPLY_MISMATCH" });
  });
});
