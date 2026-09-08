import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import * as schema from "@shared/schema";
import { DEFAULT_SUPPLIER_SOURCING_POLICY, type SupplierSourcingPolicy } from "@shared/procurement/supplier-sourcing";
import { fixtureTable, fixtureForeignKeys } from "./shipment-line-fixture";
import { SupplierSourcingRepository, attachSupplierSourcingCandidates } from "../../supplier-sourcing.repository";
import { SupplierSourcingService } from "../../supplier-sourcing.service";
import { generatePurchasingRecommendations } from "../../purchasing-recommendation.engine";

const url=process.env.ECHELON_TEST_DATABASE_URL;
const integration=url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const NOW=new Date("2026-09-07T12:00:00Z");
const policy: SupplierSourcingPolicy={...DEFAULT_SUPPLIER_SOURCING_POLICY,priceList:{currency:"USD",basis:"per_purchase_uom",purchaseUom:"case",piecesPerPurchaseUom:50,quoteReference:"SYNTHETIC-QUOTE",quotedAt:"2026-09-01T00:00:00Z",validFrom:"2026-09-01",validUntil:"2026-09-30",tiers:[{minimumQuantity:1,unitCostMills:100001},{minimumQuantity:10,unitCostMills:90001}]}};
integration.sequential("real PostgreSQL supplier sourcing revisions and planning",()=>{
  let pool:pg.Pool; let lease:pg.PoolClient; let database:ReturnType<typeof drizzle>; let repository:SupplierSourcingRepository; let service:SupplierSourcingService;
  const owned:string[]=[];
  beforeAll(async()=>{
    if (!["127.0.0.1","localhost"].includes(new URL(url!).hostname) || [process.env.DATABASE_URL,process.env.EXTERNAL_DATABASE_URL].includes(url!)) throw new Error("Sourcing fixture requires its separate disposable local database");
    pool=new pg.Pool({connectionString:url,ssl:false,max:8,statement_timeout:15000}); lease=await pool.connect();
    const acquired=await lease.query("SELECT pg_try_advisory_lock(hashtext('echelon.procurement.cost-audit-fixture')) AS acquired"); if (!acquired.rows[0].acquired) throw new Error("Procurement fixture is already leased");
    for(const name of ["catalog","procurement"]){await pool.query(`CREATE SCHEMA ${name}`);owned.push(name);}
    const tables=[schema.products,schema.productVariants,schema.vendors,schema.vendorProducts];
    for(const table of tables) await pool.query(fixtureTable(table));
    for(const fk of fixtureForeignKeys(tables)) await pool.query(fk);
    await pool.query(readFileSync(resolve(process.cwd(),"migrations/228_supplier_sourcing_policies.sql"),"utf8"));
    database=drizzle(pool);repository=new SupplierSourcingRepository(database);service=new SupplierSourcingService(repository,()=>NOW);
  });
  beforeEach(async()=>{
    if(owned.length!==2) throw new Error("Missing fixture ownership");
    // Only fixture-owned tables in the explicitly disposable local database.
    // Temporarily disable the statement guard within one atomic cleanup command.
    await pool.query("BEGIN; ALTER TABLE procurement.supplier_sourcing_revisions DISABLE TRIGGER supplier_sourcing_history_truncate_immutable; TRUNCATE procurement.supplier_sourcing_revisions,procurement.vendor_products,procurement.vendors,catalog.product_variants,catalog.products RESTART IDENTITY CASCADE; ALTER TABLE procurement.supplier_sourcing_revisions ENABLE TRIGGER supplier_sourcing_history_truncate_immutable; COMMIT");
    await pool.query(`INSERT INTO catalog.products(id,sku,name) VALUES(10,'SYNTHETIC-SOURCE','Synthetic product'); INSERT INTO catalog.product_variants(id,product_id,sku,name,units_per_variant) VALUES(100,10,'SYNTHETIC-CASE','Synthetic case',50); INSERT INTO procurement.vendors(id,code,name,default_lead_time_days) VALUES(1,'SYN1','Synthetic preferred',10),(2,'SYN2','Synthetic alternate',20); INSERT INTO procurement.vendor_products(id,vendor_id,product_id,is_preferred,moq,pack_size,lead_time_days) VALUES(1,1,10,1,1,1,10),(2,2,10,0,1,1,20)`);
  });
  afterAll(async()=>{try{for(const name of [...owned].reverse())await pool.query(`DROP SCHEMA ${name} CASCADE`);}finally{if(lease){await lease.query("SELECT pg_advisory_unlock(hashtext('echelon.procurement.cost-audit-fixture'))");lease.release();}await pool?.end();}});
  function command(expectedRevision=0,after:SupplierSourcingPolicy=policy){return{expectedRevision,idempotencyKey:randomUUID(),reason:"Supplier quote confirmed",policy:after};}
  it("saves an audited revision and exactly replays it after a later revision",async()=>{
    const first=command(); const saved=await service.update(1,first,"operator"); await service.update(1,command(1,{...policy,priority:5}),"operator");
    expect(saved.record).toMatchObject({revision:1,recordedBy:"operator",recordedAt:NOW.toISOString()});
    expect(await service.update(1,first,"operator")).toEqual({...saved,reused:true});
    expect((await service.history(1,null)).records.map((record)=>record.revision)).toEqual([2,1]);
    expect((await pool.query("SELECT before_policy FROM procurement.supplier_sourcing_revisions WHERE revision=2")).rows[0].before_policy).toEqual(policy);
  });
  it("rejects stale concurrent edits with one committed revision",async()=>{
    const outcomes=await Promise.allSettled([service.update(1,command(),"one"),service.update(1,command(),"two")]);
    expect(outcomes.filter((result)=>result.status==="fulfilled")).toHaveLength(1);expect(outcomes.filter((result)=>result.status==="rejected")).toHaveLength(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.supplier_sourcing_revisions")).rows[0].count).toBe(1);
  });
  it("rejects actor/payload changes under an existing request key",async()=>{
    const input=command();await service.update(1,input,"one"); await expect(service.update(1,input,"two")).rejects.toMatchObject({code:"SUPPLIER_SOURCING_IDEMPOTENCY_CONFLICT"});
    await expect(service.update(1,{...input,reason:"Different input"},"one")).rejects.toMatchObject({code:"SUPPLIER_SOURCING_IDEMPOTENCY_CONFLICT"});
  });
  it("protects history and supplier mapping identity at the database boundary",async()=>{
    await service.update(1,command(),"operator");
    await expect(pool.query("UPDATE procurement.supplier_sourcing_revisions SET reason='overwrite'")).rejects.toThrow("immutable");
    await expect(pool.query("DELETE FROM procurement.supplier_sourcing_revisions")).rejects.toThrow("immutable");
    await expect(pool.query("TRUNCATE procurement.supplier_sourcing_revisions")).rejects.toThrow("immutable");
    await expect(pool.query("DELETE FROM procurement.vendor_products WHERE id=1")).rejects.toMatchObject({code:"23503"});
  });
  it("rejects malformed tier writes even when bypassing the application boundary",async()=>{
    const bad={...policy,priceList:{...policy.priceList!,tiers:[{minimumQuantity:1,unitCostMills:0.5}]}};
    await expect(pool.query("INSERT INTO procurement.supplier_sourcing_revisions(vendor_product_id,revision,idempotency_key,request_hash,policy,reason,recorded_by,recorded_at) VALUES(1,1,$1,repeat('a',64),$2,'Invalid source','operator',$3)",[randomUUID(),JSON.stringify(bad),NOW])).rejects.toThrow("Invalid quantity-price tier");
    expect((await service.read(1)).revision).toBe(0);
  });
  it.each([{ currency: null }, { quoteReference: null }, { validFrom: null }, { tiers: null }, { tiers: [{ minimumQuantity: null, unitCostMills: null }] }])("rejects null quote fields at the database boundary: %j", async (patch) => {
    const invalid = { ...policy, priceList: { ...policy.priceList!, ...patch } };
    await expect(pool.query("INSERT INTO procurement.supplier_sourcing_revisions(vendor_product_id,revision,idempotency_key,request_hash,policy,reason,recorded_by,recorded_at) VALUES(1,1,$1,repeat('a',64),$2,'Invalid source','operator',$3)", [randomUUID(), JSON.stringify(invalid), NOW])).rejects.toThrow();
    expect((await service.read(1)).revision).toBe(0);
  });
  it("rolls back a write and its history after an application failure",async()=>{
    const original=repository.insert.bind(repository); repository.insert=async(...args)=>{await original(...args);throw new Error("Synthetic post-write failure");};
    try{await expect(service.update(1,command(),"operator")).rejects.toThrow("Synthetic");}finally{repository.insert=original;}
    expect((await service.read(1)).revision).toBe(0);
  });
  it("feeds persisted tier and priority revisions into the real recommendation engine",async()=>{
    await service.update(1,command(),"operator");await service.update(2,command(0,{...policy,priority:5}),"operator");
    const raw={product_id:10,variant_id:100,base_sku:"SYNTHETIC-SOURCE",total_pieces:0,total_outbound_pieces:60,previous_outbound_pieces:60,demand_order_count:20,demand_active_days:15,latest_demand_at:"2026-09-06T12:00:00Z",safety_stock_days:0,on_order_pieces:0,recommendation_analysis_date:"2026-09-07"};
    const run=async()=>generatePurchasingRecommendations({asOf:NOW,lookbackDays:30,rows:await attachSupplierSourcingCandidates(database,[raw])}).items[0];
    const preferred=await run();expect(preferred).toMatchObject({preferredVendorId:1,suggestedOrderPieces:50,estimatedCostMills:2000});
    await service.update(1,command(1,{...policy,eligibleForProposals:false}),"operator");
    const alternate=await run();expect(alternate.preferredVendorId).toBe(2);expect(alternate.supplierBasis.sourcingSelection?.method).toBe("ranked_alternate");
    expect(preferred.supplierBasis.sourcingSelection?.options[0].tier?.priceList).toEqual(policy.priceList);
    expect(preferred.supplierBasis.sourcingSelection?.options[0].revision).toBe(1);
  });
  it("handles missing mappings and rejects invalid or future quotes without writes",async()=>{
    await expect(service.read(999)).rejects.toMatchObject({statusCode:404});
    await expect(service.update(1,command(0,{...policy,priceList:{...policy.priceList!,quotedAt:"2026-09-08T00:00:00Z",validFrom:"2026-09-08"}}),"operator")).rejects.toMatchObject({code:"SUPPLIER_QUOTE_FUTURE"});
    expect((await service.read(1)).revision).toBe(0);
  });
});
