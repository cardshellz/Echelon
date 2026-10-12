import { afterEach,beforeEach,describe,expect,it } from "vitest";
import { randomUUID } from "node:crypto";
import { createInventoryCutoverTestDatabase,type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../../../inventory-planning/__tests__/fixtures/inventory-cutover-composition-database.fixture";
import { installEbayPublicationInventoryFixture } from "../../../inventory-planning/__tests__/fixtures/ebay-publication-inventory.fixture";
import { ensureEbayPublicationReady } from "../../../inventory-planning/infrastructure/ebay-publication-readiness.repository";
const url=process.env.ECHELON_TEST_DATABASE_URL,disposable=process.env.ECHELON_TEST_DATABASE_DISPOSABLE==="true";
describe.skipIf(!url||!disposable)("normal eBay publication prepares stock automatically",()=>{
  let database:InventoryCutoverTestDatabase;
  const source={channelId:67,connectionId:9,productId:20,accountId:"seller-36",environment:"production"as const,variants:[{productVariantId:101,sku:"P5"}]};
  const context=()=>({commandKey:randomUUID(),actor:"listing-operator",now:new Date("2026-10-12T12:00:00Z")});
  beforeEach(async()=>{database=await createInventoryCutoverTestDatabase(url,disposable,cutoverCompositionBaseSql);await installEbayPublicationInventoryFixture(database.pool);},30000);
  afterEach(async()=>{await database?.close();});
  it("seals exact stock mapping before provider work and replays after stock changes",async()=>{
    const command=context();await ensureEbayPublicationReady(database.pool,source,command);
    const before=(await database.pool.query("SELECT * FROM inventory.publication_mapping_preparations")).rows;
    expect(before).toHaveLength(1);
    expect((await database.pool.query("SELECT * FROM inventory.publication_membership_heads WHERE publication_target_id=3")).rows).toEqual([]);
    await database.pool.query("UPDATE inventory.inventory_levels SET variant_qty=variant_qty+5 WHERE product_variant_id=101");
    await ensureEbayPublicationReady(database.pool,source,command);
    expect((await database.pool.query("SELECT * FROM inventory.publication_mapping_preparations")).rows).toEqual(before);
    expect((await database.pool.query("SELECT * FROM inventory.quantity_publication_attempts")).rows).toEqual([]);
  });
  it("preserves a committed mapping receipt but refuses publication after channel deselection",async()=>{
    const command=context();await ensureEbayPublicationReady(database.pool,source,command);
    await database.pool.query("INSERT INTO channels.channel_product_overrides(channel_id,product_id,is_listed) VALUES(67,20,0)");
    await expect(ensureEbayPublicationReady(database.pool,source,command)).rejects.toMatchObject({code:"STOCK_LISTING_NOT_SELECTED"});
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.publication_mapping_preparations")).rows[0].n).toBe(1);
  });
  it("converges concurrent deliveries of the same saved job to one mapping receipt",async()=>{
    const command=context();
    await Promise.all([ensureEbayPublicationReady(database.pool,source,command),ensureEbayPublicationReady(database.pool,source,command)]);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.publication_mapping_preparations")).rows[0].n).toBe(1);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.publication_variant_mapping_heads WHERE publication_target_id=3")).rows[0].n).toBe(1);
  });
  it("rolls automatic setup back on audit failure and safely retries the same job",async()=>{
    const command=context();await database.pool.query(`CREATE FUNCTION reject_mapping_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='inventory_availability.listing_mapping.prepared' THEN RAISE EXCEPTION 'audit unavailable';END IF;RETURN NEW;END $$;
      CREATE TRIGGER reject_mapping_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION reject_mapping_audit()`);
    await expect(ensureEbayPublicationReady(database.pool,source,command)).rejects.toThrow("audit unavailable");
    expect((await database.pool.query("SELECT * FROM inventory.publication_variant_mapping_heads WHERE publication_target_id=3")).rows).toEqual([]);
    expect((await database.pool.query("SELECT * FROM inventory.ebay_publication_readiness_applications")).rows).toEqual([]);
    await database.pool.query("DROP TRIGGER reject_mapping_audit ON public.audit_events");
    await ensureEbayPublicationReady(database.pool,source,command);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.publication_mapping_preparations")).rows[0].n).toBe(1);
  });
});
