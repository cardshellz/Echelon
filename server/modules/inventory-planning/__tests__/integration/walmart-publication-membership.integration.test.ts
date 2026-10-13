import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../fixtures/inventory-cutover-composition-database.fixture";
import { activateWalmartPublicationInventoryFixture, installWalmartPublicationInventoryFixture, WALMART_INVENTORY_NOW } from "../fixtures/walmart-publication-inventory.fixture";
import { PostgresVerifiedListingStockStore } from "../../infrastructure/verified-listing-stock.repository";
import { VerifiedListingStockService } from "../../application/verified-listing-stock.service";
import { installCutoverAdmissionFixturePrerequisites } from "../fixtures/inventory-cutover-admission.fixture";
import { readFileSync } from "node:fs";

const url=process.env.ECHELON_TEST_DATABASE_URL,disposable=process.env.ECHELON_TEST_DATABASE_DISPOSABLE==="true";
describe.skipIf(!url||!disposable)("retired membership evidence",()=>{
  let database:InventoryCutoverTestDatabase;
  beforeEach(async()=>{
    database=await createInventoryCutoverTestDatabase(url,disposable,cutoverCompositionBaseSql);
    await installWalmartPublicationInventoryFixture(database.pool,{includeWalmartMapping:false});
    await activateWalmartPublicationInventoryFixture(database.pool);
    await installCutoverAdmissionFixturePrerequisites(database.pool);
    await database.pool.query(readFileSync("migrations/236_inventory_cutover_admission.sql","utf8"));
    await database.pool.query(`
      UPDATE channels.channel_feeds SET channel_product_id='WPID-P5';
      INSERT INTO inventory.publication_membership_versions(publication_target_id,product_variant_id,version,included,definition_hash,review_hash,created_by,created_at)
        VALUES(2,101,1,false,repeat('a',64),repeat('a',64),'historical-operator',transaction_timestamp());
      INSERT INTO inventory.publication_membership_heads(publication_target_id,product_variant_id,active_version_id)
        SELECT 2,101,id FROM inventory.publication_membership_versions WHERE publication_target_id=2;`);
  },30000);
  afterEach(async()=>{await database?.close();});
  const input=()=>({channelId:36,connectionId:8,accountId:"partner-36",environment:"production",externalScopeId:"test-location",productVariantId:101,sku:"P5",
    externalProductId:"WPID-P5",lifecycleStatus:"ACTIVE",publishedStatus:"PUBLISHED",observedAt:WALMART_INVENTORY_NOW.toISOString()});
  const history=async()=>(await database.pool.query(`SELECT to_jsonb(v) AS version,to_jsonb(h) AS head FROM inventory.publication_membership_versions v
    JOIN inventory.publication_membership_heads h ON h.active_version_id=v.id WHERE v.publication_target_id=2`)).rows;
  it("uses channel selection and never rewrites historical exclusion evidence",async()=>{
    const before=await history();
    const service=new VerifiedListingStockService(new PostgresVerifiedListingStockStore(database.pool),()=>WALMART_INVENTORY_NOW);
    expect(await service.connect(input())).toMatchObject({state:"connected",quantities:[{productVariantId:101,desiredQuantity:"17"}]});
    expect(await history()).toEqual(before);
    expect((await database.pool.query("SELECT * FROM inventory.publication_membership_applications WHERE publication_target_id=2")).rows).toEqual([]);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.publication_mapping_preparations WHERE publication_target_id=2")).rows[0].n).toBe(1);
  });
  it("respects the actual channel exclusion independently of old membership",async()=>{
    await database.pool.query("INSERT INTO channels.channel_product_overrides(channel_id,product_id,is_listed) VALUES(36,20,0)");
    const before=await history();
    const service=new VerifiedListingStockService(new PostgresVerifiedListingStockStore(database.pool),()=>WALMART_INVENTORY_NOW);
    expect(await service.connect(input())).toMatchObject({state:"excluded",receipt:null});
    expect(await history()).toEqual(before);
    expect((await database.pool.query("SELECT * FROM inventory.publication_mapping_preparations")).rows).toEqual([]);
  });
});
